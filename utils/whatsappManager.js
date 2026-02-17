/**
 * WhatsApp Manager - Baileys Version
 * Core module for managing WhatsApp connections using @whiskeysockets/baileys
 * No browser/Chromium required - uses WebSocket protocol
 */

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidDecode, Browsers, downloadMediaMessage, getContentType, proto, isJidBroadcast, isJidNewsletter, isJidStatusBroadcast } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const pino = require('pino');
const NodeCache = require('node-cache');

const { db } = require('../config/database');
const logger = require('./logger');
const webhookDeliveryService = require('./webhookDeliveryService');
const aiAutoReply = require('./aiAutoReply');

// ============================================================================
// SUPPRESS LIBSIGNAL CONSOLE SPAM
// ============================================================================
// libsignal's session_record.js and session_cipher.js use raw console.info/
// console.error to dump full session objects (including crypto keys) and
// decryption errors. This is a security risk (leaks key material to logs)
// and creates excessive noise. Intercept and redirect to our logger.
// ============================================================================

const _origConsoleInfo = console.info;
const _origConsoleError = console.error;

console.info = function (...args) {
  // Suppress libsignal session dumps: "Closing session:", "Opening session:"
  if (typeof args[0] === 'string' && /^(Closing|Opening) session/i.test(args[0])) {
    return; // silently drop — contains raw crypto keys
  }
  _origConsoleInfo.apply(console, args);
};

console.error = function (...args) {
  // Suppress libsignal decrypt failures: "Failed to decrypt message...", "Session error:"
  if (typeof args[0] === 'string' && /^(Failed to decrypt message|Session error)/i.test(args[0])) {
    logger.debug(`[SIGNAL] ${args[0]}`);
    return;
  }
  _origConsoleError.apply(console, args);
};

console.warn = (function (origWarn) {
  return function (...args) {
    if (typeof args[0] === 'string' && /^Session already (closed|open)/i.test(args[0])) {
      return;
    }
    origWarn.apply(console, args);
  };
})(console.warn);

// ============================================================================
// CONFIGURATION
// ============================================================================

const AUTH_STATES_DIR = path.join(__dirname, '..', 'auth_states');

// Message retry counter cache
const msgRetryCounterCache = new NodeCache({ stdTTL: 600, checkperiod: 60 });

// ============================================================================
// MESSAGE STORE FOR RETRY SYSTEM
// ============================================================================
// Baileys needs getMessage() to return real message content for its retry
// mechanism (when WA server requests a message re-send for decryption).
// Without this, retries fail silently and messages can't be decrypted.
// We keep a bounded LRU-style cache of recently sent/received messages.
// ============================================================================
const MESSAGE_STORE_MAX = 5000;
const messageStore = new Map(); // key: `${remoteJid}|${msgId}` → proto.Message

function storeMessage(key, message) {
  if (!key?.id || !message) return;
  const storeKey = `${key.remoteJid}|${key.id}`;
  messageStore.set(storeKey, message);
  // Evict oldest entries when cache grows too large
  if (messageStore.size > MESSAGE_STORE_MAX) {
    const firstKey = messageStore.keys().next().value;
    messageStore.delete(firstKey);
  }
}

function getStoredMessage(key) {
  if (!key?.id) return undefined;
  const storeKey = `${key.remoteJid}|${key.id}`;
  return messageStore.get(storeKey);
}

// Duplicate message prevention
const recentMessageHashes = new Map();
const DUPLICATE_WINDOW_MS = 60000;

// ============================================================================
// HUMAN BEHAVIOR SIMULATION
// ============================================================================

/**
 * Generate a random delay within a range (simulates human timing)
 */
function humanDelay(minMs, maxMs) {
  const base = minMs + Math.random() * (maxMs - minMs);
  // Add slight Gaussian-like jitter for more natural distribution
  const jitter = (Math.random() + Math.random() + Math.random()) / 3 * (maxMs - minMs) * 0.1;
  return Math.floor(base + jitter);
}

/**
 * Calculate typing delay based on message length (humans type ~40 WPM)
 */
function typingDelay(messageLength) {
  // Average human reads/composes at ~200ms per character, with variation
  const baseDelay = Math.min(800 + messageLength * 30, 4000);
  return humanDelay(Math.floor(baseDelay * 0.7), Math.floor(baseDelay * 1.3));
}

/**
 * Random delay before reading a message (humans don't read instantly)
 */
function readReceiptDelay() {
  return humanDelay(1500, 5000);
}

/**
 * Pick a random browser fingerprint per account (stored in memory)
 * This prevents all accounts from having identical fingerprints
 */
const BROWSER_PROFILES = [
  () => Browsers.windows('Desktop'),
  () => Browsers.macOS('Desktop'),
  () => Browsers.appropriate('Desktop'),
  () => ['Windows', 'Chrome', '10.0.22631'],
  () => ['Windows', 'Edge', '10.0.22631'],
  () => ['Mac OS', 'Safari', '14.6.1'],
  () => ['Mac OS', 'Chrome', '14.4.1'],
];
const accountBrowserCache = new Map();

function getBrowserForAccount(accountId) {
  if (!accountBrowserCache.has(accountId)) {
    // Deterministic selection based on accountId hash so it stays consistent across restarts
    const hash = crypto.createHash('md5').update(accountId).digest();
    const index = hash[0] % BROWSER_PROFILES.length;
    accountBrowserCache.set(accountId, BROWSER_PROFILES[index]());
  }
  return accountBrowserCache.get(accountId);
}

// ============================================================================
// WHATSAPP MANAGER CLASS
// ============================================================================

class WhatsAppManager {
  constructor() {
    this.connections = new Map(); // accountId -> socket
    this.connectionStates = new Map(); // accountId -> { status, error, qr }
    this.io = null;
    this.reconnectAttempts = new Map();
    this.reconnectTimers = new Map(); // accountId -> timer
    this.deletedAccounts = new Set(); // Track deleted accounts to prevent reconnection
    this.connectionLocks = new Set(); // Prevent concurrent connection attempts
    this.sessionSaveLocks = new Set(); // Prevent concurrent session saves
    this.sessionConflictCounts = new Map(); // Track 440 errors specifically
    this.lastConnectionAttempt = new Map(); // Track timing to prevent rapid reconnects
    this.lastReconnectRequest = new Map(); // Track manual reconnect requests for debounce
    this.connectionWatchdogs = new Map(); // Watchdog timers for stuck connections
    this.isShuttingDown = false; // Prevent reconnection during shutdown
    this.maxReconnectAttempts = 5;
    this.maxSessionConflicts = 3; // Max 440 errors before requiring manual reconnect
    this.minReconnectInterval = 60000; // Minimum 60 seconds between any reconnection
    this.qrTimeoutMs = 60000; // QR code generation timeout (60 seconds)
    this.metrics = {
      messagesReceived: 0,
      messagesSent: 0,
      connectionsTotal: 0,
      reconnections: 0
    };

    // Bidirectional LID ↔ Phone mapping
    // Keys: LID number (e.g. "110789050532030") → phone number (e.g. "919876543210")
    // and vice-versa for reverse lookups
    this.lidToPhone = new Map();
    this.phoneToLid = new Map();
  }

  /**
   * Set Socket.IO instance for real-time updates
   */
  setSocketIO(io) {
    this.io = io;
  }

  /**
   * Emit event to dashboard
   */
  emit(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  /**
   * Emit event to specific account room
   */
  emitToAccount(accountId, event, data) {
    if (this.io) {
      this.io.to(`account-${accountId}`).emit(event, data);
    }
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeConnections: this.connections.size
    };
  }

  /**
   * Get account runtime status
   */
  getAccountStatus(accountId) {
    const state = this.connectionStates.get(accountId);
    return state || { status: 'disconnected' };
  }

  /**
   * Schedule a reconnection with proper tracking
   */
  scheduleReconnect(accountId, delay) {
    // Don't schedule reconnect if shutting down
    if (this.isShuttingDown) {
      logger.info(`Not scheduling reconnect for ${accountId} - app is shutting down`);
      return;
    }

    // Cancel any existing reconnect timer
    const existingTimer = this.reconnectTimers.get(accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(accountId);
      if (!this.deletedAccounts.has(accountId) && !this.isShuttingDown) {
        this.connect(accountId).catch(e => {
          logger.error(`Scheduled reconnection failed for ${accountId}: ${e.message}`);
        });
      }
    }, delay);
    
    this.reconnectTimers.set(accountId, timer);
  }

  /**
   * Handle session conflict (status 440) - CRITICAL for ban prevention
   */
  async handleSessionConflict(accountId) {
    const conflictCount = (this.sessionConflictCounts.get(accountId) || 0) + 1;
    this.sessionConflictCounts.set(accountId, conflictCount);

    logger.warn(`Session conflict #${conflictCount} for account ${accountId}`);

    if (conflictCount >= this.maxSessionConflicts) {
      // Too many conflicts - stop trying, require manual intervention
      logger.error(`Persistent session conflict for ${accountId} (${conflictCount} times), stopping auto-reconnect`);
      
      this.connectionStates.set(accountId, { status: 'error', error: 'Session conflict - phone may be using WhatsApp' });
      await db.updateAccount(accountId, { 
        status: 'error',
        error_message: 'Session conflict detected. Please ensure WhatsApp is not open on your phone, wait 5 minutes, then click Reconnect.'
      }).catch(e => logger.warn(`Failed to update account: ${e.message}`));
      
      this.emit('account-status', { 
        accountId, 
        status: 'error', 
        message: 'Session conflict - please wait and reconnect manually' 
      });
      
      // Reset conflict counter after 10 minutes
      setTimeout(() => {
        this.sessionConflictCounts.delete(accountId);
      }, 600000);
      
      return;
    }

    // Exponential backoff for 440: 60s, 120s, 240s with jitter
    const baseDelay = 60000 * Math.pow(2, conflictCount - 1);
    const jitter = Math.floor(Math.random() * 15000);
    const delay = baseDelay + jitter;

    logger.info(`Waiting ${delay}ms before reconnect attempt for ${accountId} (conflict #${conflictCount})`);
    
    this.connectionStates.set(accountId, { status: 'reconnecting' });
    this.emit('account-status', { accountId, status: 'reconnecting', message: `Waiting ${Math.round(delay/1000)}s...` });
    
    this.scheduleReconnect(accountId, delay);
  }

  /**
   * Clear corrupted session and require re-authentication
   */
  async clearCorruptedSession(accountId) {
    logger.warn(`Clearing corrupted session for account ${accountId}`);

    // Clear all tracking
    this.sessionConflictCounts.delete(accountId);
    this.reconnectAttempts.delete(accountId);
    this.connectionLocks.delete(accountId);

    // Cancel any pending reconnect
    const timer = this.reconnectTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(accountId);
    }

    // Clear auth state files
    const authPath = path.join(AUTH_STATES_DIR, `session_${accountId}`);
    try {
      await fs.rm(authPath, { recursive: true, force: true });
      await fs.mkdir(authPath, { recursive: true });
    } catch (e) {
      logger.warn(`Could not clear auth files: ${e.message}`);
    }

    // Update database
    this.connectionStates.set(accountId, { status: 'disconnected' });
    await db.updateAccount(accountId, { 
      status: 'disconnected',
      session_data: null,
      qr_code: null,
      error_message: 'Session corrupted - please scan QR code to reconnect'
    }).catch(e => logger.warn(`Failed to update account: ${e.message}`));

    this.emit('account-status', { 
      accountId, 
      status: 'disconnected', 
      message: 'Session expired - please reconnect' 
    });
  }

  /**
   * Generate a new API key
   */
  generateApiKey() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Register a LID ↔ Phone mapping (bidirectional)
   */
  registerLidPhoneMapping(lidJidOrNumber, phoneJidOrNumber) {
    if (!lidJidOrNumber || !phoneJidOrNumber) return;
    
    const lid = String(lidJidOrNumber).split('@')[0];
    const phone = String(phoneJidOrNumber).split('@')[0];
    
    // Don't map a number to itself
    if (lid === phone) return;
    // Sanity check: phone numbers are typically 7-15 digits
    if (!/^\d{7,15}$/.test(phone)) return;
    
    if (!this.lidToPhone.has(lid)) {
      logger.info(`[LID-MAP] Mapped LID ${lid} → phone ${phone}`);
    }
    this.lidToPhone.set(lid, phone);
    this.phoneToLid.set(phone, lid);

    // Persist mappings to disk asynchronously (fire-and-forget).
    // Survives restarts so LID resolution works immediately on reconnect.
    this._saveLidMappingsDebounced();
  }

  /**
   * Debounced save of LID mappings to disk (batches rapid updates)
   */
  _saveLidMappingsDebounced() {
    if (this._lidSaveTimer) clearTimeout(this._lidSaveTimer);
    this._lidSaveTimer = setTimeout(() => this._persistLidMappings(), 5000);
  }

  /**
   * Write LID mappings to a JSON file in the auth_states directory
   */
  async _persistLidMappings() {
    try {
      const data = {};
      for (const [lid, phone] of this.lidToPhone) {
        data[lid] = phone;
      }
      const filePath = path.join(AUTH_STATES_DIR, 'lid_mappings.json');
      await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
      logger.debug(`[LID-MAP] Persisted ${Object.keys(data).length} LID mappings to disk`);
    } catch (err) {
      logger.warn(`[LID-MAP] Failed to persist LID mappings: ${err.message}`);
    }
  }

  /**
   * Load persisted LID mappings from disk (called on startup)
   */
  async _loadLidMappings() {
    try {
      const filePath = path.join(AUTH_STATES_DIR, 'lid_mappings.json');
      const raw = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      let count = 0;
      for (const [lid, phone] of Object.entries(data)) {
        if (!this.lidToPhone.has(lid)) {
          this.lidToPhone.set(lid, phone);
          this.phoneToLid.set(phone, lid);
          count++;
        }
      }
      if (count > 0) {
        logger.info(`[LID-MAP] Loaded ${count} persisted LID mappings from disk`);
      }
    } catch (err) {
      // File doesn't exist yet on first run, that's fine
      if (err.code !== 'ENOENT') {
        logger.warn(`[LID-MAP] Failed to load LID mappings: ${err.message}`);
      }
    }
  }

  /**
   * Get phone number from JID.
   * Resolves LID → phone using the mapping if available.
   */
  getPhoneNumber(jid) {
    if (!jid) return null;
    
    // Handle LID format (e.g., "110789050532030@lid")
    if (jid.includes('@lid')) {
      const lidNumber = jid.split('@')[0];
      // Try to resolve via mapping
      const phone = this.lidToPhone.get(lidNumber);
      if (phone) return phone;
      // Return raw LID number as fallback
      return lidNumber;
    }
    
    const decoded = jidDecode(jid);
    return decoded?.user || jid.split('@')[0];
  }

  /**
   * Try to get real phone number from message.
   * Returns { phone, lid, fromJid } with as much info as available.
   */
  extractSenderInfo(msg, sock) {
    const remoteJid = msg.key.remoteJid;
    const isLidFormat = remoteJid?.includes('@lid');

    // ── msg.key.senderPn / participantPn: WhatsApp sends the actual phone ──
    // These fields are populated by the WhatsApp server on every message stanza
    // and are the most reliable source of phone→LID mapping.
    const senderPn = msg.key.senderPn;   // phone JID of sender (e.g. 919876543210@s.whatsapp.net)
    const senderLid = msg.key.senderLid; // LID JID of sender
    const participantPn = msg.key.participantPn; // phone JID of group participant
    const participantLid = msg.key.participantLid; // LID JID of group participant

    // Register any LID↔phone mapping we can extract from the message key
    if (senderPn && senderLid) {
      this.registerLidPhoneMapping(senderLid, senderPn);
    }
    if (participantPn && participantLid) {
      this.registerLidPhoneMapping(participantLid, participantPn);
    }
    // Also cross-register senderPn with remoteJid if it's a LID
    if (senderPn && isLidFormat) {
      this.registerLidPhoneMapping(remoteJid, senderPn);
    }
    
    // For group messages, participant contains the actual sender
    if (msg.key.participant) {
      const participantJid = msg.key.participant;
      const isParticipantLid = participantJid?.includes('@lid');
      const number = participantJid.split('@')[0];
      
      if (isParticipantLid) {
        // Try participantPn first (direct from WhatsApp), then cached mapping
        const pnPhone = participantPn ? participantPn.split('@')[0] : null;
        const resolvedPhone = pnPhone || this.lidToPhone.get(number) || null;
        return { phone: resolvedPhone, lid: number, fromJid: participantJid };
      } else {
        const decoded = jidDecode(participantJid);
        const phone = decoded?.user || number;
        const resolvedLid = this.phoneToLid.get(phone) || null;
        return { phone, lid: resolvedLid, fromJid: participantJid };
      }
    }
    
    if (isLidFormat) {
      const lidNumber = remoteJid.split('@')[0];
      // Try senderPn first (direct from WhatsApp), then cached mapping
      const pnPhone = senderPn ? senderPn.split('@')[0] : null;
      const resolvedPhone = pnPhone || this.lidToPhone.get(lidNumber) || null;
      return { phone: resolvedPhone, lid: lidNumber, fromJid: remoteJid };
    }
    
    // Standard phone JID
    const decoded = jidDecode(remoteJid);
    const phone = decoded?.user || remoteJid?.split('@')[0] || null;
    const resolvedLid = this.phoneToLid.get(phone) || null;
    return { phone, lid: resolvedLid, fromJid: remoteJid };
  }

  /**
   * Legacy alias for backward compatibility
   */
  extractSenderPhone(msg, sock) {
    const info = this.extractSenderInfo(msg, sock);
    return info.phone || info.lid || null;
  }

  /**
   * Format phone number to standard WhatsApp JID
   */
  formatJid(phone) {
    const cleaned = phone.replace(/[^0-9]/g, '');
    return `${cleaned}@s.whatsapp.net`;
  }

  /**
   * Resolve a 'to' value to the correct JID for sending.
   * CRITICAL: Must send to the SAME JID format as the active conversation.
   * If the conversation is on @lid, sending to @s.whatsapp.net will corrupt
   * the Signal encryption session and cause CIPHERTEXT failures.
   * Supports: phone numbers, LIDs, phone@s.whatsapp.net, lid@lid, group@g.us
   */
  async resolveRecipientJid(accountId, to) {
    if (!to || typeof to !== 'string') {
      throw new Error('Invalid recipient: must be a non-empty string');
    }
    
    const trimmed = to.trim();
    
    // Already has a JID suffix — use as-is (user explicitly chose the format)
    if (trimmed.includes('@')) {
      return trimmed;
    }
    
    // Bare number — need to figure out the correct JID format
    const cleaned = trimmed.replace(/[^0-9]/g, '');
    if (!cleaned) {
      throw new Error('Invalid recipient: no digits found');
    }
    
    // 1. Check if this number is a known LID number → send to LID JID
    //    (the input IS a LID number, resolve to phone for sending)
    const phoneFromLid = this.lidToPhone.get(cleaned);
    if (phoneFromLid) {
      // This number is a LID. Check if the phone has an active LID conversation
      // Send to LID JID to preserve Signal session integrity
      logger.info(`[RESOLVE] ${cleaned} is a known LID → phone ${phoneFromLid}, sending to LID JID to preserve Signal session`);
      return `${cleaned}@lid`;
    }
    
    // 2. Check if this is a phone number with a known LID mapping
    //    → send to LID JID because WhatsApp migrated this conversation to LID
    const lidFromPhone = this.phoneToLid.get(cleaned);
    if (lidFromPhone) {
      logger.info(`[RESOLVE] Phone ${cleaned} has LID mapping ${lidFromPhone}, sending to LID JID to preserve Signal session`);
      return `${lidFromPhone}@lid`;
    }
    
    // 3. Try sock.onWhatsApp() to verify the number and get JID + LID
    const sock = this.connections.get(accountId);
    if (sock) {
      try {
        const [result] = await sock.onWhatsApp(cleaned) || [];
        if (result?.exists) {
          // Register the mapping for future use
          if (result.lid) {
            this.registerLidPhoneMapping(result.lid, result.jid);
            // If WhatsApp tells us there's a LID, use it to preserve session
            logger.info(`[RESOLVE] ${cleaned} verified → jid: ${result.jid}, lid: ${result.lid}, using LID JID`);
            return result.lid;
          }
          logger.info(`[RESOLVE] ${cleaned} verified on WhatsApp → ${result.jid} (no LID)`);
          return result.jid;
        }
      } catch (err) {
        logger.debug(`[RESOLVE] onWhatsApp failed for ${cleaned}: ${err.message}`);
      }
    }
    
    // 4. Fallback: assume it's a phone number (most common case)
    logger.info(`[RESOLVE] ${cleaned} not in mapping, assuming phone number`);
    return `${cleaned}@s.whatsapp.net`;
  }

  /**
   * Check for duplicate message
   */
  isDuplicateMessage(accountId, jid, message) {
    const msgHash = crypto.createHash('sha256').update(message).digest('hex').slice(0, 16);
    const key = `${accountId}:${jid}:${msgHash}`;
    
    const now = Date.now();
    const lastSent = recentMessageHashes.get(key);
    if (lastSent && (now - lastSent) < DUPLICATE_WINDOW_MS) {
      return true;
    }

    recentMessageHashes.set(key, now);
    
    // Cleanup old entries - evict expired entries instead of just one
    if (recentMessageHashes.size > 5000) {
      for (const [k, v] of recentMessageHashes) {
        if (now - v > DUPLICATE_WINDOW_MS) {
          recentMessageHashes.delete(k);
        }
      }
      // If still too many, remove oldest entries
      if (recentMessageHashes.size > 8000) {
        const keysToDelete = Array.from(recentMessageHashes.keys()).slice(0, 2000);
        keysToDelete.forEach(k => recentMessageHashes.delete(k));
      }
    }

    return false;
  }

  /**
   * Initialize all accounts from database
   */
  async initializeAccounts() {
    try {
      // Load persisted LID mappings before connecting accounts
      await this._loadLidMappings();

      const accounts = await db.getAccounts();
      const toConnect = accounts.filter(a => a.status === 'ready' || a.session_data);
      logger.info(`Found ${accounts.length} accounts, ${toConnect.length} to initialize`);

      for (let i = 0; i < toConnect.length; i++) {
        const account = toConnect[i];
        try {
          await this.connect(account.id);
        } catch (e) {
          logger.error(`Failed to initialize account ${account.id}: ${e.message}`);
        }
        // Stagger connections to avoid hitting WhatsApp servers all at once
        if (i < toConnect.length - 1) {
          const staggerDelay = humanDelay(3000, 6000);
          logger.debug(`Waiting ${staggerDelay}ms before next account initialization`);
          await new Promise(resolve => setTimeout(resolve, staggerDelay));
        }
      }

      // Start periodic health monitor after all accounts initialized
      this._startHealthMonitor();
    } catch (error) {
      logger.error('Failed to initialize accounts:', error.message);
    }
  }

  // ============================================================================
  // CONNECTION HEALTH MONITOR
  // ============================================================================
  // Periodically checks all accounts that should be connected.
  // If an account is stuck in 'reconnecting' for too long or the socket
  // appears dead, forces a fresh reconnection.
  // ============================================================================
  _startHealthMonitor() {
    // Run every 5 minutes
    const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;
    // Max time an account can be in 'reconnecting' state before forced action
    const MAX_RECONNECTING_MS = 10 * 60 * 1000;

    this._healthMonitorInterval = setInterval(async () => {
      if (this.isShuttingDown) return;

      try {
        const accounts = await db.getAccounts();
        const now = Date.now();

        for (const account of accounts) {
          if (this.deletedAccounts.has(account.id)) continue;
          if (this.isShuttingDown) break;

          const state = this.connectionStates.get(account.id);
          const sock = this.connections.get(account.id);
          const hasSession = !!account.session_data;

          // Skip accounts without sessions (not yet authenticated)
          if (!hasSession) continue;

          // Case 1: Account should be connected but has no socket and no pending reconnect
          if (!sock && !this.reconnectTimers.has(account.id) && !this.connectionLocks.has(account.id)) {
            const stateStatus = state?.status;
            if (stateStatus !== 'qr_ready' && stateStatus !== 'initializing') {
              logger.warn(`[HEALTH] Account ${account.id} has no active connection, triggering reconnect`);
              this.scheduleReconnect(account.id, humanDelay(5000, 15000));
            }
          }

          // Case 2: Account stuck in 'reconnecting' state for too long
          if (state?.status === 'reconnecting') {
            const lastAttempt = this.lastConnectionAttempt.get(account.id) || 0;
            if (now - lastAttempt > MAX_RECONNECTING_MS) {
              logger.warn(`[HEALTH] Account ${account.id} stuck in reconnecting for ${Math.round((now - lastAttempt) / 60000)}min, forcing reconnect`);
              // Reset counters and force reconnect
              this.reconnectAttempts.delete(account.id);
              this.connectionLocks.delete(account.id);
              const timer = this.reconnectTimers.get(account.id);
              if (timer) {
                clearTimeout(timer);
                this.reconnectTimers.delete(account.id);
              }
              this.scheduleReconnect(account.id, humanDelay(3000, 8000));
            }
          }

          // Case 3: Account in 'error' state with a session — try self-healing
          if (state?.status === 'error' && hasSession) {
            const attempts = this.reconnectAttempts.get(account.id) || 0;
            // Only auto-heal if we haven't exceeded max attempts recently
            if (attempts < this.maxReconnectAttempts) {
              logger.info(`[HEALTH] Account ${account.id} in error state with valid session, attempting recovery`);
              this.reconnectAttempts.set(account.id, attempts + 1);
              this.scheduleReconnect(account.id, humanDelay(30000, 60000));
            }
          }
        }
      } catch (err) {
        logger.error(`[HEALTH] Health monitor error: ${err.message}`);
      }
    }, HEALTH_CHECK_INTERVAL);

    // Don't prevent process exit
    this._healthMonitorInterval.unref?.();
    logger.info('[HEALTH] Connection health monitor started (5 min interval)');
  }

  /**
   * Create new WhatsApp account
   */
  async createAccount(name, description = '') {
    try {
      const apiKey = this.generateApiKey();
      
      const account = await db.createAccount({
        name,
        description,
        status: 'initializing',
        api_key: apiKey
      });

      logger.info(`Account created: ${account.id} (${name})`);
      this.metrics.connectionsTotal++;

      // Start connection in BACKGROUND - don't await
      // This allows frontend to subscribe to socket events before QR is generated
      setImmediate(() => {
        this.connect(account.id).catch(e => {
          logger.error(`Background connect failed for ${account.id}: ${e.message}`);
        });
      });

      return account;
    } catch (error) {
      logger.error('Failed to create account:', error.message);
      throw error;
    }
  }

  /**
   * Delete WhatsApp account - Complete cleanup
   */
  async deleteAccount(accountId) {
    try {
      logger.info(`Starting complete deletion of account ${accountId}`);
      
      // Mark as deleted to prevent reconnection attempts
      this.deletedAccounts.add(accountId);

      // Clear any pending reconnection timer
      const timer = this.reconnectTimers.get(accountId);
      if (timer) {
        clearTimeout(timer);
        this.reconnectTimers.delete(accountId);
      }

      // Clear watchdog timer
      this.clearConnectionWatchdog(accountId);

      // Clear all tracking for this account
      this.reconnectAttempts.delete(accountId);
      this.sessionConflictCounts.delete(accountId);
      this.connectionLocks.delete(accountId);
      this.lastConnectionAttempt.delete(accountId);
      this.lastReconnectRequest?.delete(accountId);
      this.connectionStates.delete(accountId);

      // Disconnect if connected - end the socket properly
      const sock = this.connections.get(accountId);
      if (sock) {
        try {
          // Logout to invalidate the session on WhatsApp servers
          logger.info(`Logging out WhatsApp session for ${accountId}`);
          await sock.logout();
          // Wait after logout to ensure it's processed
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e) {
          logger.debug(`Logout failed (expected if already disconnected): ${e.message}`);
        }
        try {
          sock.end();
        } catch (e) {
          // Ignore
        }
        this.connections.delete(accountId);
      }

      // Clean up auth state files BEFORE database delete
      const authPath = path.join(AUTH_STATES_DIR, `session_${accountId}`);
      try {
        // First try to remove the directory
        await fs.rm(authPath, { recursive: true, force: true });
        
        // Verify deletion
        try {
          await fs.access(authPath);
          // If we can still access it, try again
          logger.warn(`Auth files still exist for ${accountId}, retrying deletion`);
          await new Promise(resolve => setTimeout(resolve, 500));
          await fs.rm(authPath, { recursive: true, force: true });
        } catch {
          // Good - directory doesn't exist anymore
        }
        
        logger.info(`Auth files deleted for account ${accountId}`);
      } catch (e) {
        logger.warn(`Could not delete auth files: ${e.message}`);
      }

      // Clear QR code and session data BEFORE full deletion
      // This helps ensure no stale data remains
      try {
        await db.updateAccount(accountId, {
          session_data: null,
          qr_code: null,
          status: 'disconnected'
        });
      } catch (e) {
        // May fail if account already deleted, that's ok
      }

      // Delete from database (this will cascade delete webhooks, ai_configs, etc.)
      await db.deleteAccount(accountId);
      logger.info(`Database records deleted for account ${accountId}`);

      this.emit('account-deleted', { accountId });

      // Remove from deleted set after a delay (prevent race conditions)
      // Using 30 seconds instead of 60 to allow faster re-creation
      setTimeout(() => this.deletedAccounts.delete(accountId), 30000);

      logger.info(`Account ${accountId} completely deleted`);
      return true;
    } catch (error) {
      logger.error(`Failed to delete account ${accountId}:`, error.message);
      // Still try to clean up local state even if DB fails
      this.connections.delete(accountId);
      this.connectionStates.delete(accountId);
      this.reconnectTimers.delete(accountId);
      this.connectionLocks.delete(accountId);
      this.deletedAccounts.delete(accountId);
      throw error;
    }
  }

  /**
   * Connect WhatsApp account
   */
  async connect(accountId) {
    try {
      // Check if account was deleted
      if (this.deletedAccounts.has(accountId)) {
        logger.info(`Skipping connection for deleted account ${accountId}`);
        return;
      }

      // Prevent concurrent connection attempts (causes session conflicts!)
      if (this.connectionLocks.has(accountId)) {
        logger.warn(`Connection already in progress for ${accountId}, skipping`);
        return null;
      }

      // Set connection lock immediately
      this.connectionLocks.add(accountId);
      
      // Check if this is a new account (no existing session data)
      // Use skipCache=true to get fresh data (avoid stale session_data from cache)
      const accountCheck = await db.getAccountById(accountId, true);
      const isNewAccount = !accountCheck?.session_data;

      // Enforce minimum interval between connection attempts
      // But skip rate limiting for new accounts that need QR scanning
      const lastAttempt = this.lastConnectionAttempt.get(accountId);
      if (lastAttempt && !isNewAccount) {
        const elapsed = Date.now() - lastAttempt;
        if (elapsed < this.minReconnectInterval) {
          const waitTime = this.minReconnectInterval - elapsed;
          logger.info(`Rate limiting reconnection for ${accountId}, waiting ${waitTime}ms`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

      this.lastConnectionAttempt.set(accountId, Date.now());

      // Disconnect existing connection if any
      if (this.connections.has(accountId)) {
        await this.disconnect(accountId, false);
        // Wait after disconnect to prevent rapid reconnect
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      const account = accountCheck; // Use already-fetched account
      if (!account) {
        logger.warn(`Account ${accountId} not found in database, skipping connection`);
        this.connectionStates.delete(accountId);
        this.reconnectAttempts.delete(accountId);
        this.connectionLocks.delete(accountId);
        return;
      }

      // Update state
      this.connectionStates.set(accountId, { status: 'initializing' });
      await db.updateAccount(accountId, { status: 'initializing', error_message: null });

      // Setup auth state
      const authPath = path.join(AUTH_STATES_DIR, `session_${accountId}`);
      await fs.mkdir(authPath, { recursive: true });

      // Restore session from database if exists
      // restoreSession validates creds before writing — if invalid, it clears session_data
      // and we fall through to a fresh QR code flow
      if (account.session_data) {
        await this.restoreSession(accountId, account.session_data, authPath);
      }

      // Clean up any stale/partial auth files before Baileys reads them
      // If creds.json exists but has registered=false and no 'me', remove it
      try {
        const credsPath = path.join(authPath, 'creds.json');
        const credsExists = await fs.access(credsPath).then(() => true).catch(() => false);
        if (credsExists) {
          const credsRaw = await fs.readFile(credsPath, 'utf8');
          const creds = JSON.parse(credsRaw);
          if (creds.registered === false && !creds.me) {
            logger.warn(`Stale creds.json on disk for ${accountId} (registered=false, no me), cleaning up`);
            await fs.rm(authPath, { recursive: true, force: true });
            await fs.mkdir(authPath, { recursive: true });
          }
        }
      } catch (credsCheckErr) {
        logger.debug(`Creds validation check skipped: ${credsCheckErr.message}`);
      }

      const { state, saveCreds } = await useMultiFileAuthState(authPath);

      // Get latest Baileys version (with fallback)
      let version;
      try {
        const versionResult = await fetchLatestBaileysVersion();
        version = versionResult.version;
      } catch (versionErr) {
        logger.warn(`Failed to fetch Baileys version, using fallback: ${versionErr.message}`);
        version = [2, 3000, 1015901307];
      }

      // Create silent logger for Baileys
      const baileysLogger = pino({ level: 'silent' });

      // Pick a consistent browser fingerprint for this account
      const browserProfile = getBrowserForAccount(accountId);

      // Create socket with proper browser identification
      // Settings tuned to mimic official WhatsApp Web behavior
      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: browserProfile,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        // Don't immediately set online — real WhatsApp Web does this lazily
        markOnlineOnConnect: false,

        // ── getMessage: CRITICAL for message retry system ──
        // When WA server can't decrypt a message, it asks the client to
        // re-send the original message content. Without this, the retry
        // fails silently, causing Bad MAC errors and lost messages.
        getMessage: async (key) => {
          const stored = getStoredMessage(key);
          if (stored) {
            logger.debug(`[RETRY] Found stored message for retry: ${key.id}`);
            return stored;
          }
          logger.debug(`[RETRY] No stored message found for ${key.id}, returning empty`);
          return { conversation: '' };
        },

        // ── shouldIgnoreJid: reduces Bad MAC / session noise ──
        // Skip broadcast, newsletter, status, and meta AI JIDs.
        // These JIDs generate signal sessions that are rarely needed
        // and are a major source of Bad MAC / decrypt errors.
        shouldIgnoreJid: (jid) => {
          return isJidBroadcast(jid)
            || isJidNewsletter(jid)
            || isJidStatusBroadcast(jid)
            || jid?.endsWith('@bot');  // Meta AI bots
        },

        // ── shouldSyncHistoryMessage: allow critical sync types ──
        // Baileys warns: "DISABLING ALL SYNC PREVENTS BAILEYS FROM
        // ACCESSING INITIAL LID MAPPINGS". We allow INITIAL_BOOTSTRAP
        // and PUSH_NAME to get LID mappings on first connection.
        shouldSyncHistoryMessage: (msg) => {
          // Always sync these types for LID mapping population
          const syncType = msg.syncType;
          const allowedTypes = [
            proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
            proto.HistorySync.HistorySyncType.PUSH_NAME,
            proto.HistorySync.HistorySyncType.RECENT,
          ];
          return allowedTypes.includes(syncType);
        },

        msgRetryCounterCache,
        linkPreviewImageThumbnailWidth: 0,
        qrTimeout: 40000,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        // Patch-based presence to reduce detection surface
        patchMessageBeforeSending: (message) => {
          // Don't modify — just pass through. Having the handler
          // registered prevents Baileys from adding its own metadata
          return message;
        },
        // Firewall / keep-alive tuning
        keepAliveIntervalMs: 25000, // 25s keep-alive like real WA Web
        retryRequestDelayMs: 250,
        // Allow more retry attempts for failed decryptions (default is 5)
        maxMsgRetryCount: 10,
      });

      // Store connection
      this.connections.set(accountId, sock);

      // Setup event handlers
      this.setupEventHandlers(accountId, sock, saveCreds);

      // Release lock after short delay (handlers take over)
      // Use shorter delay - 30s is enough for QR generation
      const lockReleaseDelay = isNewAccount ? 30000 : 5000;
      setTimeout(() => this.connectionLocks.delete(accountId), lockReleaseDelay);

      // Setup watchdog timer to detect stuck connections
      // If no QR generated or no connection within timeout, mark as error
      // Applies to ALL connections, not just new accounts
      this.setupConnectionWatchdog(accountId);

      logger.info(`Connection initiated for account ${accountId} (new: ${isNewAccount})`);
      
      return sock;
    } catch (error) {
      this.connectionLocks.delete(accountId);
      this.clearConnectionWatchdog(accountId);
      logger.error(`Failed to connect account ${accountId}:`, error.message);
      this.connectionStates.set(accountId, { status: 'error', error: error.message });
      await db.updateAccount(accountId, { status: 'error', error_message: error.message });
      throw error;
    }
  }

  /**
   * Setup watchdog timer for stuck connections
   */
  setupConnectionWatchdog(accountId) {
    // Clear any existing watchdog
    this.clearConnectionWatchdog(accountId);
    
    const watchdog = setTimeout(async () => {
      const state = this.connectionStates.get(accountId);
      
      // Only trigger if still in initializing state (no QR, no connection)
      if (state?.status === 'initializing') {
        logger.warn(`Connection watchdog triggered for ${accountId} - stuck in initializing`);
        
        this.connectionStates.set(accountId, { 
          status: 'error', 
          error: 'Connection timed out' 
        });
        
        await db.updateAccount(accountId, {
          status: 'error',
          error_message: 'Connection timed out. Please click Reconnect to try again.'
        }).catch(e => logger.warn(`Failed to update account: ${e.message}`));
        
        this.emit('account-status', { 
          accountId, 
          status: 'error', 
          message: 'Connection timed out - click Reconnect' 
        });
        
        // Cleanup
        this.connectionLocks.delete(accountId);
        const sock = this.connections.get(accountId);
        if (sock) {
          try { sock.end(); } catch (e) { /* ignore */ }
          this.connections.delete(accountId);
        }
      }
      
      this.connectionWatchdogs.delete(accountId);
    }, this.qrTimeoutMs);
    
    this.connectionWatchdogs.set(accountId, watchdog);
  }

  /**
   * Clear watchdog timer
   */
  clearConnectionWatchdog(accountId) {
    const watchdog = this.connectionWatchdogs.get(accountId);
    if (watchdog) {
      clearTimeout(watchdog);
      this.connectionWatchdogs.delete(accountId);
    }
  }

  /**
   * Setup event handlers for WhatsApp socket
   */
  setupEventHandlers(accountId, sock, saveCreds) {
    // Global error handler for socket events - prevents unhandled rejections
    sock.ev.on('error', (error) => {
      logger.error(`Socket error for account ${accountId}: ${error.message}`);
      // Don't crash, let connection.update handle reconnection
    });

    // Track whether QR was just scanned successfully (pair-success triggers
    // isNewLogin=true before the server restarts the connection).
    // We must NOT treat that subsequent close as a failure.
    let justPaired = false;

    // Connection update
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr, isNewLogin } = update;

        // Baileys signals pair-success with isNewLogin=true right before
        // asking the server to restart the connection.  Mark it so the
        // close handler below reconnects quickly instead of deleting
        // the freshly-written credentials.
        if (isNewLogin) {
          justPaired = true;
          logger.info(`QR scan successful for account ${accountId}, expecting connection restart`);
        }

        if (qr) {
          // QR generated - clear watchdog timer (connection is progressing)
          this.clearConnectionWatchdog(accountId);
          
          // Generate QR code with higher quality for better scanning
          const qrDataUrl = await qrcode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 300,
            color: {
              dark: '#000000',
              light: '#ffffff'
            }
          });
          this.connectionStates.set(accountId, { status: 'qr_ready', qr: qrDataUrl });
          
          await db.updateAccount(accountId, { 
            status: 'qr_ready', 
            qr_code: qrDataUrl,
            error_message: null
          });

          // Emit to both specific account room and broadcast
          this.emit('qr-update', { accountId, qr: qrDataUrl });
          this.emitToAccount(accountId, 'qr-update', { accountId, qr: qrDataUrl });
          this.emit('account-status', { accountId, status: 'qr_ready' });
          logger.info(`QR code generated for account ${accountId}`);
        }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || '';

        logger.warn(`Connection closed for account ${accountId}: ${statusCode} - ${errorMessage}`);

        // Clear watchdog and release lock
        this.clearConnectionWatchdog(accountId);
        this.connectionLocks.delete(accountId);
        
        // Clean up the dead socket reference
        this.connections.delete(accountId);

        // Don't reconnect if app is shutting down
        if (this.isShuttingDown) {
          logger.info(`App shutting down, not reconnecting account ${accountId}`);
          return;
        }

        // Check if account was deleted - don't try to reconnect or update DB
        if (this.deletedAccounts.has(accountId)) {
          logger.info(`Account ${accountId} was deleted, skipping reconnection`);
          return;
        }

        // ── Fast-path: QR just scanned (pair-success → server restart) ──
        // After a successful QR scan, Baileys sets isNewLogin=true then the
        // server closes the WS (usually 515 restartRequired or 428).
        // The creds.update handler is still saving the valid authenticated
        // credentials in the background.  We must NOT delete the auth files
        // or treat this as a failure — just reconnect quickly.
        if (justPaired) {
          logger.info(`Post-QR-scan restart for ${accountId} (status ${statusCode}), reconnecting in 3s`);
          this.connectionStates.set(accountId, { status: 'reconnecting' });
          await db.updateAccount(accountId, {
            status: 'initializing',
            qr_code: null,
            error_message: null
          }).catch(e => logger.warn(`Failed to update account status: ${e.message}`));
          this.emit('account-status', { accountId, status: 'reconnecting', message: 'QR scanned, reconnecting...' });
          
          // Give saveCreds/saveSession a moment to finish writing, then reconnect
          this.scheduleReconnect(accountId, 3000);
          return;
        }

        // Handle undefined status code (usually happens during shutdown or network issues)
        if (statusCode === undefined) {
          const account = await db.getAccountById(accountId).catch(() => null);
          
          if (!account?.session_data) {
            // New account - undefined error during QR scan
            logger.info(`Undefined status for new account ${accountId}, allowing manual retry`);
            this.connectionStates.set(accountId, { status: 'disconnected', error: 'Connection interrupted' });
            await db.updateAccount(accountId, { 
              status: 'disconnected',
              qr_code: null,
              error_message: 'Connection was interrupted. Please click Reconnect to try again.'
            }).catch(e => logger.warn(`Failed to update account status: ${e.message}`));
            this.emit('account-status', { accountId, status: 'disconnected', message: 'Connection interrupted - click Reconnect' });
          } else {
            // Established account - wait and reconnect
            logger.info(`Undefined status code for ${accountId}, waiting 60s before reconnect`);
            this.connectionStates.set(accountId, { status: 'reconnecting' });
            this.scheduleReconnect(accountId, 60000);
          }
          return;
        }

        // Handle Bad MAC / session corruption errors - require full re-auth
        if (errorMessage.includes('Bad MAC') || errorMessage.includes('decrypt')) {
          logger.error(`Session corrupted for ${accountId} (Bad MAC), clearing session`);
          await this.clearCorruptedSession(accountId);
          return;
        }

        // Status 440 = Session conflict - CRITICAL: handle carefully to prevent ban
        if (statusCode === 440) {
          await this.handleSessionConflict(accountId);
          return;
        }

        // Status 428 = Connection closed prematurely - wait longer
        if (statusCode === 428) {
          logger.warn(`Premature close for ${accountId}, waiting 60s before reconnect`);
          this.connectionStates.set(accountId, { status: 'reconnecting' });
          this.scheduleReconnect(accountId, 60000);
          return;
        }

        // Status 408 = QR timeout / connection lost
        // For new accounts (no session): treat as QR timeout, wait for user
        // For established accounts: treat as connection lost, auto-reconnect
        if (statusCode === 408) {
          const acct = await db.getAccountById(accountId).catch(() => null);
          if (!acct?.session_data) {
            logger.info(`QR timeout for ${accountId}, waiting for user to reconnect`);
            this.connectionStates.set(accountId, { status: 'disconnected', error: 'QR code expired' });
            await db.updateAccount(accountId, { 
              status: 'disconnected', 
              qr_code: null,
              error_message: 'QR code expired. Click Reconnect to try again.'
            }).catch(e => logger.warn(`Failed to update account status: ${e.message}`));
            this.emit('account-status', { accountId, status: 'disconnected', message: 'QR expired - click Reconnect' });
          } else {
            logger.warn(`Connection lost (408) for established account ${accountId}, reconnecting in 30s`);
            this.connectionStates.set(accountId, { status: 'reconnecting' });
            this.scheduleReconnect(accountId, 30000);
          }
          return;
        }

        // Status 500 = Bad session - clear corrupted session and retry
        if (statusCode === 500 || statusCode === DisconnectReason.badSession) {
          logger.warn(`Bad session for ${accountId}, clearing session for re-auth`);
          await this.clearCorruptedSession(accountId);
          return;
        }

        // Status 403 = Forbidden - account may be banned or restricted
        if (statusCode === 403) {
          logger.error(`Account ${accountId} forbidden (possibly banned)`);
          this.connectionStates.set(accountId, { status: 'error', error: 'Account forbidden' });
          await db.updateAccount(accountId, {
            status: 'error',
            error_message: 'Connection forbidden. Your WhatsApp account may be restricted.'
          }).catch(e => logger.warn(`Failed to update account: ${e.message}`));
          this.emit('account-status', { accountId, status: 'error', message: 'Account forbidden' });
          return;
        }

        // Status 411 = Multi-device mismatch - clear session
        if (statusCode === 411) {
          logger.warn(`Multi-device mismatch for ${accountId}, clearing session`);
          await this.clearCorruptedSession(accountId);
          return;
        }

        // Status 503 = Service unavailable - temporary, retry after delay
        if (statusCode === 503) {
          logger.warn(`WhatsApp service unavailable for ${accountId}, retrying in 60s`);
          this.connectionStates.set(accountId, { status: 'reconnecting' });
          this.scheduleReconnect(accountId, 60000);
          return;
        }

        // Status 401 = Logged out / session invalid
        // (DisconnectReason.loggedOut === 401 in Baileys)
        if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
          const account = await db.getAccountById(accountId).catch(() => null);
          const hadSession = account?.session_data != null;
          
          if (hadSession) {
            // Had a session but now invalid — user logged out or session expired
            logger.info(`Account ${accountId} logged out / session invalid, clearing for re-auth`);
            await this.clearCorruptedSession(accountId);
          } else {
            // New account never authenticated - mark disconnected
            logger.info(`New account ${accountId} connection failed, waiting for manual reconnect`);
            this.connectionStates.set(accountId, { status: 'disconnected', error: 'Connection failed' });
            await db.updateAccount(accountId, { 
              status: 'disconnected',
              error_message: 'Connection failed. Click Reconnect to try again.'
            }).catch(e => logger.warn(`Failed to update account status: ${e.message}`));
            this.emit('account-status', { accountId, status: 'disconnected', message: 'Connection failed - click Reconnect' });
          }
          return;
        }

        // Status 515 = Stream error - needs restart but handle differently for new vs established accounts
        if (statusCode === 515) {
          const account = await db.getAccountById(accountId).catch(() => null);
          
          if (!account?.session_data) {
            // New account - stream error during QR scan/auth
            // This is common during initial connection, allow immediate retry
            logger.warn(`Stream error for new account ${accountId}, clearing auth state for fresh start`);
            
            // Clear any partial auth state that may be corrupted
            const authPath = path.join(AUTH_STATES_DIR, `session_${accountId}`);
            try {
              await fs.rm(authPath, { recursive: true, force: true });
              await fs.mkdir(authPath, { recursive: true });
            } catch (e) {
              // Ignore
            }
            
            this.connectionStates.set(accountId, { status: 'disconnected', error: 'Connection failed during authentication' });
            await db.updateAccount(accountId, { 
              status: 'disconnected',
              qr_code: null,
              error_message: 'Connection failed during QR scan. Please click Reconnect to try again.'
            }).catch(e => logger.warn(`Failed to update account status: ${e.message}`));
            
            this.emit('account-status', { accountId, status: 'disconnected', message: 'Connection failed - click Reconnect' });
          } else {
            // Established account - use longer delay
            logger.warn(`Stream error for ${accountId}, waiting 120s before reconnect`);
            this.connectionStates.set(accountId, { status: 'reconnecting' });
            this.scheduleReconnect(accountId, 120000);
          }
          return;
        }

        // Other errors - use exponential backoff but only for established accounts
        const account = await db.getAccountById(accountId).catch(() => null);
        if (!account?.session_data) {
          // New account - don't auto-reconnect, wait for user
          logger.info(`New account ${accountId} error ${statusCode}, waiting for manual reconnect`);
          this.connectionStates.set(accountId, { status: 'error', error: errorMessage });
          await db.updateAccount(accountId, { 
            status: 'error',
            error_message: `Error ${statusCode}: ${errorMessage}. Click Reconnect to try again.`
          }).catch(e => logger.warn(`Failed to update account status: ${e.message}`));
          this.emit('account-status', { accountId, status: 'error', message: errorMessage });
          return;
        }

        // Established account with session - try auto-reconnect with exponential backoff
        const attempts = this.reconnectAttempts.get(accountId) || 0;
        
        if (attempts < this.maxReconnectAttempts) {
          this.reconnectAttempts.set(accountId, attempts + 1);
          this.metrics.reconnections++;
          
          // Exponential backoff with jitter: 60s, 120s, 240s, 480s, 960s + random 0-30s
          const baseDelay = Math.min(60000 * Math.pow(2, attempts), 960000);
          const jitter = Math.floor(Math.random() * 30000);
          const delay = baseDelay + jitter;
          
          logger.info(`Reconnecting account ${accountId} in ${Math.round(delay/1000)}s (attempt ${attempts + 1}/${this.maxReconnectAttempts})`);
          this.connectionStates.set(accountId, { status: 'reconnecting' });
          this.scheduleReconnect(accountId, delay);
        } else {
          logger.error(`Max reconnection attempts reached for account ${accountId}`);
          this.connectionStates.set(accountId, { status: 'error', error: 'Max reconnection attempts reached' });
          await db.updateAccount(accountId, { status: 'error', error_message: 'Max reconnection attempts reached' })
            .catch(e => logger.warn(`Failed to update account status: ${e.message}`));
          this.emit('account-status', { accountId, status: 'error', message: 'Max reconnection attempts - please reconnect manually' });
        }
      }

      if (connection === 'open') {
        // Successfully connected - clear watchdog and reset all error tracking
        this.clearConnectionWatchdog(accountId);
        
        const phoneNumber = sock.user?.id ? this.getPhoneNumber(sock.user.id) : null;
        
        this.connectionStates.set(accountId, { status: 'ready', phoneNumber });
        this.reconnectAttempts.delete(accountId);
        this.sessionConflictCounts.delete(accountId); // Reset conflict counter on success
        this.connectionLocks.delete(accountId);

        await db.updateAccount(accountId, { 
          status: 'ready', 
          phone_number: phoneNumber,
          qr_code: null,
          error_message: null,
          last_active_at: new Date().toISOString()
        });

        // Save session to database
        await this.saveSession(accountId);

        this.emit('account-status', { accountId, status: 'ready', phoneNumber });
        logger.info(`Account ${accountId} connected successfully (${phoneNumber})`);

        // Set presence to 'unavailable' after connection — mimics real WA Web
        // (real clients don't stay online 24/7; they go idle)
        setTimeout(async () => {
          try {
            await sock.sendPresenceUpdate('unavailable');
            logger.debug(`Set initial presence to unavailable for ${accountId}`);
          } catch (e) {
            logger.debug(`Could not set initial presence: ${e.message}`);
          }
        }, humanDelay(3000, 8000));

        // Notify via webhook
        webhookDeliveryService.dispatch(accountId, 'connection', {
          status: 'connected',
          phoneNumber
        });
      }
      } catch (error) {
        logger.error(`Error in connection.update handler for ${accountId}: ${error.message}`);
      }
    });

    // Credentials update
    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        
        // Brief delay to ensure creds.json is fully flushed to disk
        // before we try to read it back. Without this, rapid creds.update
        // events cause "Unexpected end of JSON input" from partial reads.
        await new Promise(r => setTimeout(r, 100));
        
        // Only persist to database when creds represent a fully authenticated
        // session (i.e. QR was scanned and pair-success completed).
        const authPath = path.join(AUTH_STATES_DIR, `session_${accountId}`);
        try {
          const credsRaw = await fs.readFile(path.join(authPath, 'creds.json'), 'utf8');
          const creds = JSON.parse(credsRaw);
          if (creds.me && creds.registered !== false) {
            await this.saveSession(accountId);
          } else {
            logger.debug(`Skipping DB session save for ${accountId} (not yet authenticated)`);
          }
        } catch (readErr) {
          // File might still be partially written — wait and retry once
          await new Promise(r => setTimeout(r, 250));
          try {
            const credsRaw = await fs.readFile(path.join(authPath, 'creds.json'), 'utf8');
            const creds = JSON.parse(credsRaw);
            if (creds.me && creds.registered !== false) {
              await this.saveSession(accountId);
            }
          } catch (retryErr) {
            logger.debug(`Skipping session save for ${accountId} — creds.json not ready yet: ${retryErr.message}`);
          }
        }
      } catch (error) {
        logger.error(`Error saving creds for ${accountId}: ${error.message}`);
      }
    });

    // Incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      logger.debug(`messages.upsert event: type=${type}, count=${messages.length}`);

      // Store ALL messages (including history) in cache for retry system.
      // This is critical: when WA server asks us to re-send a message for
      // decryption, getMessage() looks up the stored content.
      for (const msg of messages) {
        if (msg.key && msg.message) {
          storeMessage(msg.key, msg.message);
        }
      }

      // Only process 'notify' type for webhook dispatch (not history sync)
      if (type !== 'notify') {
        logger.info(`[MESSAGE] Ignoring messages.upsert batch (type=${type}, count=${messages.length}) — only 'notify' triggers webhooks`);
        return;
      }

      for (const msg of messages) {
        // Log incoming (non-fromMe) messages at INFO, own messages at DEBUG
        // to avoid log spam from history sync of sent messages
        if (msg.key.fromMe) {
          logger.debug(`[MESSAGE] messages.upsert: fromMe=true, remoteJid=${msg.key.remoteJid}, hasContent=${!!msg.message}`);
          continue;
        }

        logger.info(`[MESSAGE] messages.upsert: fromMe=false, remoteJid=${msg.key.remoteJid}, hasContent=${!!msg.message}, pushName=${msg.pushName || 'N/A'}`);

        // Handle message in background to not block event loop
        this.handleIncomingMessage(accountId, msg).catch(err => {
          logger.error(`Error in message handler for account ${accountId}:`, err.message);
        });
      }
    });

    // Message status updates
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.update?.status) {
          const remoteJid = update.key.remoteJid;
          const phone = this.getPhoneNumber(remoteJid);
          webhookDeliveryService.dispatch(accountId, 'message.status', {
            messageId: update.key.id,
            status: update.update.status,
            remoteJid,
            phone: phone || null
          });
        }
      }
    });

    // === LID ↔ Phone mapping from contact sync ===
    // Baileys emits contacts.upsert during app state sync with both
    // id (phone@s.whatsapp.net) and lid (lid@lid) fields.
    // Contact objects also have a 'jid' field (phone format) separate from 'id'.
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        const phoneJid = contact.jid || (contact.id?.includes('@s.whatsapp.net') ? contact.id : null);
        const lidJid = contact.lid || (contact.id?.includes('@lid') ? contact.id : null);
        if (phoneJid && lidJid) {
          this.registerLidPhoneMapping(lidJid, phoneJid);
        }
      }
    });

    sock.ev.on('contacts.update', (contacts) => {
      for (const contact of contacts) {
        const phoneJid = contact.jid || (contact.id?.includes('@s.whatsapp.net') ? contact.id : null);
        const lidJid = contact.lid || (contact.id?.includes('@lid') ? contact.id : null);
        if (phoneJid && lidJid) {
          this.registerLidPhoneMapping(lidJid, phoneJid);
        }
      }
    });

    // WhatsApp fires this when a user explicitly shares their phone number
    // in a LID-based conversation — definitive LID→phone mapping
    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      if (lid && jid) {
        this.registerLidPhoneMapping(lid, jid);
        logger.info(`[LID-MAP] Phone number shared: ${lid} → ${jid}`);
      }
    });

    // ── History sync: bulk LID mapping population ──
    // On first connection (or reconnect), Baileys syncs history including
    // contacts with both phone JID and LID. This is the primary source
    // of LID→phone mappings. Without this, most LIDs stay unresolved.
    sock.ev.on('messaging-history.set', ({ contacts, messages, chats }) => {
      let mappedCount = 0;

      // Extract LID mappings from synced contacts
      if (contacts?.length) {
        for (const contact of contacts) {
          // Contact objects have: id, lid, jid fields
          // 'jid' is the phone format, 'lid' is the anonymous format
          if (contact.lid && contact.jid) {
            this.registerLidPhoneMapping(contact.lid, contact.jid);
            mappedCount++;
          } else if (contact.id && contact.lid) {
            this.registerLidPhoneMapping(contact.lid, contact.id);
            mappedCount++;
          }
        }
      }

      // Extract LID↔phone mappings from synced chats
      // Chat objects (proto.IConversation) have pnJid (phone) and lidJid (LID)
      if (chats?.length) {
        for (const chat of chats) {
          if (chat.pnJid && chat.lidJid) {
            this.registerLidPhoneMapping(chat.lidJid, chat.pnJid);
            mappedCount++;
          } else if (chat.lid && chat.id && chat.id.includes('@s.whatsapp.net')) {
            this.registerLidPhoneMapping(chat.lid, chat.id);
            mappedCount++;
          }
        }
      }

      // Store synced messages in the message store for retry system
      // Also extract LID mappings from message keys (senderPn/senderLid)
      if (messages?.length) {
        for (const msg of messages) {
          if (msg.key && msg.message) {
            storeMessage(msg.key, msg.message);
          }
          // Extract LID↔phone from message key metadata
          if (msg.key?.senderPn && msg.key?.senderLid) {
            this.registerLidPhoneMapping(msg.key.senderLid, msg.key.senderPn);
          }
        }
      }

      if (mappedCount > 0) {
        logger.info(`[HISTORY-SYNC] Registered ${mappedCount} LID→phone mappings from history sync (contacts + chats)`);
      }
      if (messages?.length) {
        logger.debug(`[HISTORY-SYNC] Stored ${messages.length} messages for retry cache`);
      }
    });
  }

  /**
   * Handle incoming message — extracts all content including media,
   * then dispatches enriched payload to webhooks
   */
  async handleIncomingMessage(accountId, msg) {
    try {
      this.metrics.messagesReceived++;

      const sock = this.connections.get(accountId);
      if (!sock) {
        logger.warn(`Socket not found for account ${accountId}`);
        return;
      }

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');

      // Delayed read receipt — humans don't read instantly
      const readDelay = readReceiptDelay();
      setTimeout(() => {
        sock.readMessages([msg.key]).catch(err => {
          logger.debug(`Could not send read receipt: ${err.message}`);
        });
      }, readDelay);
      
      const isLidFormat = remoteJid?.includes('@lid');
      const senderInfo = this.extractSenderInfo(msg, sock);

      // If sender is a LID and we still don't have a phone mapping after extractSenderInfo
      // (which already checks msg.key.senderPn), try additional resolution strategies.
      if (isLidFormat && !senderInfo.phone && sock) {
        const lidNumber = senderInfo.lid;
        logger.info(`[LID-MAP] No phone mapping for LID ${lidNumber} (pushName: ${msg.pushName || 'Unknown'}), attempting active resolution...`);

        // Strategy 1: Check Baileys store contacts for this LID
        if (sock.store?.contacts) {
          const lidJid = `${lidNumber}@lid`;
          const contact = sock.store.contacts[lidJid];
          if (contact?.jid && contact.jid.includes('@s.whatsapp.net')) {
            const resolvedPhone = contact.jid.split('@')[0];
            this.registerLidPhoneMapping(lidNumber, resolvedPhone);
            senderInfo.phone = resolvedPhone;
            logger.info(`[LID-MAP] Resolved LID ${lidNumber} → phone ${resolvedPhone} via store contacts (jid field)`);
          } else if (contact?.id && contact.id.includes('@s.whatsapp.net')) {
            const resolvedPhone = contact.id.split('@')[0];
            this.registerLidPhoneMapping(lidNumber, resolvedPhone);
            senderInfo.phone = resolvedPhone;
            logger.info(`[LID-MAP] Resolved LID ${lidNumber} → phone ${resolvedPhone} via store contacts (id field)`);
          }
        }

        // Strategy 2: Try onWhatsApp() API call as last resort (5s timeout)
        if (!senderInfo.phone) {
          try {
            const onWhatsAppPromise = sock.onWhatsApp(lidNumber);
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('onWhatsApp timeout')), 5000)
            );
            const [result] = await Promise.race([onWhatsAppPromise, timeoutPromise]) || [];
            if (result?.exists && result.jid && result.jid.includes('@s.whatsapp.net')) {
              const resolvedPhone = result.jid.split('@')[0];
              this.registerLidPhoneMapping(lidNumber, resolvedPhone);
              senderInfo.phone = resolvedPhone;
              logger.info(`[LID-MAP] Resolved LID ${lidNumber} → phone ${resolvedPhone} via onWhatsApp()`);
            }
          } catch (err) {
            logger.debug(`[LID-MAP] onWhatsApp() resolution failed for ${lidNumber}: ${err.message}`);
          }
        }

        if (!senderInfo.phone) {
          logger.warn(`[LID-MAP] Could not resolve phone for LID ${lidNumber} — phone will be null in webhook payload`);
        }
      }

      const senderPhone = senderInfo.phone || senderInfo.lid || null;
      const replyJid = remoteJid;
      const contactId = senderPhone;
      
      // ====== EXTRACT MESSAGE CONTENT + MEDIA ======

      let messageText = '';
      let messageType = 'text';
      let mediaData = null; // base64-encoded media for webhook
      let mediaMimetype = null;
      let mediaFilename = null;
      let mediaDuration = null;
      let mediaFileSize = null;
      let mediaWidth = null;
      let mediaHeight = null;
      let thumbnailBase64 = null;

      const message = msg.message;
      if (!message) {
        // Distinguish stub notifications (group events) from decryption failures
        if (msg.messageStubType === 2) {
          // StubType 2 = CIPHERTEXT: Baileys received the message but FAILED to
          // decrypt it. The Signal session with this contact is corrupted.
          // Baileys auto-sends up to 5 retry receipts, but if those also fail
          // the session stays broken. Force-reset the Signal session so the
          // NEXT message from this contact can be decrypted successfully.
          logger.warn(`[MESSAGE] CIPHERTEXT (decryption failure) from ${contactId} (pushName: ${msg.pushName || 'Unknown'}, jid: ${remoteJid}, msgId: ${msg.key.id}). Forcing Signal session reset...`);
          try {
            await sock.assertSessions([remoteJid], true);
            logger.info(`[MESSAGE] Signal session reset for ${remoteJid} — next message should decrypt OK`);
            // Save session to DB immediately after Signal session reset.
            // Without this, if the server restarts, the old corrupt session
            // is restored from DB and CIPHERTEXT errors return.
            await this.saveSession(accountId);
            logger.debug(`[MESSAGE] Session saved to DB after Signal session reset for ${remoteJid}`);
          } catch (sessErr) {
            logger.error(`[MESSAGE] Failed to reset Signal session for ${remoteJid}: ${sessErr.message}`);
          }
        } else if (msg.messageStubType) {
          logger.info(`[MESSAGE] Notification stub from ${contactId} (stubType: ${msg.messageStubType}, pushName: ${msg.pushName || 'N/A'}) — no webhook sent.`);
        } else {
          logger.warn(`[MESSAGE] Received message from ${contactId} (pushName: ${msg.pushName || 'Unknown'}) but msg.message is null — likely decryption failure or empty notification. No webhook sent. msgId=${msg.key.id}`);
        }
        return;
      }

      // Unwrap viewOnce/ephemeral wrappers
      const unwrapped = message.ephemeralMessage?.message
        || message.viewOnceMessage?.message
        || message.viewOnceMessageV2?.message
        || message.documentWithCaptionMessage?.message
        || message;

      if (unwrapped.conversation) {
        messageText = unwrapped.conversation;
        messageType = 'text';
      } else if (unwrapped.extendedTextMessage?.text) {
        messageText = unwrapped.extendedTextMessage.text;
        messageType = 'text';
      } else if (unwrapped.imageMessage) {
        const m = unwrapped.imageMessage;
        messageText = m.caption || '';
        messageType = 'image';
        mediaMimetype = m.mimetype || 'image/jpeg';
        mediaFileSize = m.fileLength ? Number(m.fileLength) : null;
        mediaWidth = m.width || null;
        mediaHeight = m.height || null;
        if (m.jpegThumbnail) {
          thumbnailBase64 = Buffer.from(m.jpegThumbnail).toString('base64');
        }
      } else if (unwrapped.videoMessage) {
        const m = unwrapped.videoMessage;
        messageText = m.caption || '';
        messageType = 'video';
        mediaMimetype = m.mimetype || 'video/mp4';
        mediaFileSize = m.fileLength ? Number(m.fileLength) : null;
        mediaDuration = m.seconds || null;
        mediaWidth = m.width || null;
        mediaHeight = m.height || null;
        if (m.jpegThumbnail) {
          thumbnailBase64 = Buffer.from(m.jpegThumbnail).toString('base64');
        }
      } else if (unwrapped.audioMessage) {
        const m = unwrapped.audioMessage;
        messageText = m.ptt ? '[Voice Note]' : '[Audio]';
        messageType = m.ptt ? 'ptt' : 'audio';
        mediaMimetype = m.mimetype || 'audio/ogg; codecs=opus';
        mediaFileSize = m.fileLength ? Number(m.fileLength) : null;
        mediaDuration = m.seconds || null;
      } else if (unwrapped.documentMessage) {
        const m = unwrapped.documentMessage;
        messageText = m.caption || m.fileName || '[Document]';
        messageType = 'document';
        mediaMimetype = m.mimetype || 'application/octet-stream';
        mediaFilename = m.fileName || 'document';
        mediaFileSize = m.fileLength ? Number(m.fileLength) : null;
        if (m.jpegThumbnail) {
          thumbnailBase64 = Buffer.from(m.jpegThumbnail).toString('base64');
        }
      } else if (unwrapped.stickerMessage) {
        messageText = '[Sticker]';
        messageType = 'sticker';
        mediaMimetype = unwrapped.stickerMessage.mimetype || 'image/webp';
        mediaFileSize = unwrapped.stickerMessage.fileLength ? Number(unwrapped.stickerMessage.fileLength) : null;
      } else if (unwrapped.contactMessage) {
        messageText = unwrapped.contactMessage.displayName || '[Contact]';
        messageType = 'contact';
      } else if (unwrapped.contactsArrayMessage) {
        const names = (unwrapped.contactsArrayMessage.contacts || []).map(c => c.displayName).join(', ');
        messageText = names || '[Contacts]';
        messageType = 'contacts';
      } else if (unwrapped.locationMessage) {
        const loc = unwrapped.locationMessage;
        messageText = loc.name || loc.address || '[Location]';
        messageType = 'location';
        // Include lat/lng in media data for webhook
        mediaData = JSON.stringify({
          latitude: loc.degreesLatitude,
          longitude: loc.degreesLongitude,
          name: loc.name || null,
          address: loc.address || null,
          url: loc.url || null
        });
        mediaMimetype = 'application/json';
      } else if (unwrapped.liveLocationMessage) {
        messageText = '[Live Location]';
        messageType = 'live_location';
      } else if (unwrapped.reactionMessage) {
        messageText = unwrapped.reactionMessage.text || '';
        messageType = 'reaction';
      } else if (unwrapped.pollCreationMessage || unwrapped.pollCreationMessageV3) {
        const poll = unwrapped.pollCreationMessage || unwrapped.pollCreationMessageV3;
        messageText = poll.name || '[Poll]';
        messageType = 'poll';
      } else if (unwrapped.listMessage) {
        messageText = unwrapped.listMessage.description || unwrapped.listMessage.title || '[List]';
        messageType = 'list';
      } else if (unwrapped.buttonsMessage || unwrapped.templateMessage) {
        messageText = unwrapped.buttonsMessage?.contentText || unwrapped.templateMessage?.hydratedFourRowTemplate?.hydratedContentText || '[Interactive]';
        messageType = 'interactive';
      } else if (unwrapped.orderMessage) {
        messageText = '[Order]';
        messageType = 'order';
      } else if (unwrapped.protocolMessage) {
        // Skip protocol messages (message edits, deletes, etc.)
        logger.info(`[MESSAGE] Protocol message from ${contactId} (type: ${unwrapped.protocolMessage.type || 'unknown'}), skipping webhook`);
        return;
      } else {
        const msgTypes = Object.keys(unwrapped);
        logger.info(`[MESSAGE] Unhandled message type from ${contactId}: ${msgTypes.join(', ')}`);
        messageText = `[${msgTypes[0] || 'Unknown'}]`;
        messageType = 'unknown';
      }

      if (!messageText && messageType === 'text') {
        logger.warn(`[MESSAGE] Empty text message from ${contactId}, skipping webhook`);
        return;
      }
      if (!messageText) messageText = `[${messageType}]`;

      // ====== DOWNLOAD MEDIA (if applicable) ======
      const hasMedia = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(messageType);
      
      if (hasMedia && !mediaData) {
        try {
          // Timeout media downloads to prevent hanging the message handler
          const downloadPromise = downloadMediaMessage(
            msg,
            'buffer',
            {},
            {
              logger: pino({ level: 'silent' }),
              reuploadRequest: sock.updateMediaMessage
            }
          );
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Media download timed out after 30s')), 30000)
          );
          const buffer = await Promise.race([downloadPromise, timeoutPromise]);
          
          if (buffer && buffer.length > 0) {
            // Only include base64 for files < 10MB to prevent webhook payload bloat
            if (buffer.length < 10 * 1024 * 1024) {
              mediaData = buffer.toString('base64');
            } else {
              logger.info(`[MESSAGE] Media too large for webhook payload (${(buffer.length / 1024 / 1024).toFixed(1)}MB), sending metadata only`);
              mediaData = null;
            }
            mediaFileSize = buffer.length;
          }
        } catch (downloadErr) {
          logger.warn(`[MESSAGE] Failed to download media: ${downloadErr.message}`);
          // Continue without media data — still send text/metadata
        }
      }

      logger.info(`[MESSAGE] Received ${messageType} from ${contactId}: ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);

      // Save to conversation history in background
      db.addConversationMessage(accountId, contactId, 'incoming', messageText, messageType).catch(dbErr => {
        logger.error(`[MESSAGE] Failed to save conversation: ${dbErr.message}`);
      });

      // ====== BUILD ENRICHED WEBHOOK PAYLOAD ======
      const webhookPayload = {
        messageId: msg.key.id,
        from: senderInfo.phone || senderInfo.lid,  // Best identifier: phone if resolved, else LID
        phone: senderInfo.phone || null,            // Resolved phone number (null if only LID available)
        message: messageText,
        messageType,
        isGroup,
        timestamp: msg.messageTimestamp,
        pushName: msg.pushName || 'Unknown',
      };

      // Add group info
      if (isGroup) {
        webhookPayload.groupJid = remoteJid;
        webhookPayload.participant = msg.key.participant || null;
        // Use participantPn from message key first (most reliable), then fallback to mapping
        const participantPnJid = msg.key.participantPn;
        const participantPnPhone = participantPnJid ? participantPnJid.split('@')[0] : null;
        webhookPayload.participantPhone = participantPnPhone || (msg.key.participant ? this.getPhoneNumber(msg.key.participant) : null);
        // For group replies, include group JID so n8n can send to the group
        webhookPayload.replyTo = remoteJid;
      }

      // Add media data when available
      if (hasMedia || messageType === 'location') {
        webhookPayload.media = {
          mimetype: mediaMimetype,
          filename: mediaFilename || null,
          fileSize: mediaFileSize || null,
          duration: mediaDuration || null,
          width: mediaWidth || null,
          height: mediaHeight || null,
          data: mediaData || null,  // base64-encoded file content
          thumbnail: thumbnailBase64 || null,
        };
      }

      // Dispatch webhook
      logger.info(`[MESSAGE] Dispatching ${messageType} to webhooks for account ${accountId}...`);
      
      try {
        await webhookDeliveryService.dispatch(accountId, 'message', webhookPayload);
        logger.info(`[MESSAGE] Webhook dispatch completed for account ${accountId}`);
      } catch (webhookErr) {
        logger.error(`[MESSAGE] Webhook dispatch error: ${webhookErr.message}`);
      }

      // AI Auto-reply (only for text messages, non-group)
      if (messageType === 'text' && !isGroup) {
        // Add human-like delay before AI responds
        const aiDelay = humanDelay(2000, 6000);
        setTimeout(() => {
          aiAutoReply.generateReply({
            accountId,
            contactId,
            message: messageText
          }).then(aiReply => {
            if (aiReply) {
              this.sendMessageToJid(accountId, replyJid, aiReply).catch(err => {
                logger.error(`Failed to send AI reply: ${err.message}`);
              });
            }
          }).catch(err => {
            logger.error(`AI reply generation failed: ${err.message}`);
          });
        }, aiDelay);
      }
    } catch (error) {
      logger.error(`Error handling message for account ${accountId}: ${error.message}`);
    }
  }

  /**
   * Send text message with human-like behavior
   * Accepts any format: phone number, LID, JID
   */
  async sendMessage(accountId, phone, message) {
    const sock = this.connections.get(accountId);
    if (!sock) {
      throw new Error('Account not connected');
    }

    // Resolve phone/LID/JID to the correct JID for sending
    const jid = await this.resolveRecipientJid(accountId, phone);

    // Check for duplicate
    if (this.isDuplicateMessage(accountId, jid, message)) {
      logger.warn(`Duplicate message blocked for ${phone}`);
      throw new Error('Duplicate message detected');
    }

    try {
      // Go available briefly (like opening a chat)
      await sock.sendPresenceUpdate('available').catch(() => {});
      await new Promise(resolve => setTimeout(resolve, humanDelay(300, 800)));

      // Start typing — duration proportional to message length
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      const delay = typingDelay(message.length);
      await new Promise(resolve => setTimeout(resolve, delay));
      await sock.sendPresenceUpdate('paused', jid).catch(() => {});

      // Brief natural pause between typing stop and send
      await new Promise(resolve => setTimeout(resolve, humanDelay(200, 600)));

      // Send message
      const result = await sock.sendMessage(jid, { text: message });

      // Store sent message for retry system
      if (result?.key && result?.message) storeMessage(result.key, result.message);

      this.metrics.messagesSent++;
      
      // Save to conversation history
      // Always resolve to phone number for consistent conversation tracking
      const contactId = this.getPhoneNumber(jid) || phone;
      await db.addConversationMessage(accountId, contactId, 'outgoing', message, 'text');

      // Save session to DB after sending — sock.sendMessage() updates Signal
      // pre-keys and session state internally. If we don't persist these,
      // a server restart restores stale pre-keys → Bad MAC on next message.
      this.saveSession(accountId).catch(e => 
        logger.debug(`Post-send session save failed: ${e.message}`)
      );

      // Go unavailable after sending (like minimizing the window)
      setTimeout(() => {
        sock.sendPresenceUpdate('unavailable').catch(() => {});
      }, humanDelay(2000, 8000));

      logger.info(`Message sent to ${phone} (resolved: ${jid})`);

      return {
        success: true,
        messageId: result.key.id,
        to: jid,
        phone: this.getPhoneNumber(jid) || phone,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error(`Failed to send message to ${phone} (${jid}):`, error.message);
      throw error;
    }
  }

  /**
   * Send text message directly to a JID (supports both phone and LID JIDs)
   */
  async sendMessageToJid(accountId, jid, message) {
    const sock = this.connections.get(accountId);
    if (!sock) {
      throw new Error('Account not connected');
    }

    // Resolve the JID (handles LID→phone mapping, bare numbers, etc.)
    const resolvedJid = await this.resolveRecipientJid(accountId, jid);

    // Check for duplicate
    if (this.isDuplicateMessage(accountId, resolvedJid, message)) {
      logger.warn(`Duplicate message blocked for ${jid}`);
      throw new Error('Duplicate message detected');
    }

    try {
      // Go available briefly
      await sock.sendPresenceUpdate('available').catch(() => {});
      await new Promise(resolve => setTimeout(resolve, humanDelay(300, 800)));

      // Typing simulation with human-like duration
      await sock.sendPresenceUpdate('composing', resolvedJid).catch(() => {});
      const delay = typingDelay(message.length);
      await new Promise(resolve => setTimeout(resolve, delay));
      await sock.sendPresenceUpdate('paused', resolvedJid).catch(() => {});

      await new Promise(resolve => setTimeout(resolve, humanDelay(200, 600)));

      // Send message
      const result = await sock.sendMessage(resolvedJid, { text: message });

      // Store sent message for retry system
      if (result?.key && result?.message) storeMessage(result.key, result.message);

      this.metrics.messagesSent++;
      
      // Save to conversation history
      const contactId = this.getPhoneNumber(resolvedJid) || jid.split('@')[0];
      await db.addConversationMessage(accountId, contactId, 'outgoing', message, 'text');

      // Save session to DB after sending — Signal pre-keys update on every send
      this.saveSession(accountId).catch(e => 
        logger.debug(`Post-send session save failed: ${e.message}`)
      );

      // Go back to unavailable
      setTimeout(() => {
        sock.sendPresenceUpdate('unavailable').catch(() => {});
      }, humanDelay(2000, 8000));

      logger.info(`Message sent to ${jid} (resolved: ${resolvedJid})`);

      return {
        success: true,
        messageId: result.key.id,
        to: resolvedJid,
        phone: this.getPhoneNumber(resolvedJid) || jid.split('@')[0],
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error(`Failed to send message to ${jid} (${resolvedJid}):`, error.message);
      throw error;
    }
  }

  /**
   * Send message with auto-detection of phone number vs JID.
   * Now uses resolveRecipientJid for all formats:
   * - Phone numbers: "918005780278"
   * - LID numbers: "110789050532030" (auto-resolved via mapping)
   * - Phone JID: "918005780278@s.whatsapp.net"
   * - LID JID: "110789050532030@lid"
   * - Group JID: "120363123456@g.us"
   */
  async sendMessageAuto(accountId, to, message) {
    // resolveRecipientJid handles ALL formats — no need to branch
    return this.sendMessage(accountId, to, message);
  }

  /**
   * Send media message
   * @param {string} phoneOrJid - Phone number, LID, or full JID (all formats supported)
   */
  async sendMedia(accountId, phoneOrJid, mediaBuffer, mediaType, caption = '', mimetype = '', filename = '') {
    const sock = this.connections.get(accountId);
    if (!sock) {
      throw new Error('Account not connected');
    }

    // Resolve recipient JID (handles phone, LID, JID formats)
    const jid = await this.resolveRecipientJid(accountId, phoneOrJid);

    try {
      // Human-like media send behavior
      await sock.sendPresenceUpdate('available').catch(() => {});
      await new Promise(resolve => setTimeout(resolve, humanDelay(500, 1500)));
      
      // Show composing for realistic duration (media takes time to "select")
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, humanDelay(1500, 4000)));
      await sock.sendPresenceUpdate('paused', jid).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, humanDelay(300, 800)));

      let messageContent;

      switch (mediaType) {
        case 'image':
          messageContent = {
            image: mediaBuffer,
            caption,
            mimetype: mimetype || 'image/jpeg'
          };
          break;
        case 'document':
          messageContent = {
            document: mediaBuffer,
            caption,
            mimetype: mimetype || 'application/octet-stream',
            fileName: filename || 'document'
          };
          break;
        case 'audio':
          messageContent = {
            audio: mediaBuffer,
            mimetype: mimetype || 'audio/mp4'
          };
          break;
        case 'video':
          messageContent = {
            video: mediaBuffer,
            caption,
            mimetype: mimetype || 'video/mp4'
          };
          break;
        default:
          throw new Error(`Unsupported media type: ${mediaType}`);
      }

      const result = await sock.sendMessage(jid, messageContent);

      // Store sent message for retry system
      if (result?.key && result?.message) storeMessage(result.key, result.message);

      this.metrics.messagesSent++;
      logger.info(`Media sent to ${phoneOrJid} from account ${accountId}`);

      // Save session to DB after sending — Signal pre-keys update on every send
      this.saveSession(accountId).catch(e => 
        logger.debug(`Post-send session save failed: ${e.message}`)
      );

      // Go back to unavailable after media send
      setTimeout(() => {
        sock.sendPresenceUpdate('unavailable').catch(() => {});
      }, humanDelay(3000, 10000));

      return {
        success: true,
        messageId: result.key.id,
        to: jid,
        phone: this.getPhoneNumber(jid) || phoneOrJid,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error(`Failed to send media to ${phoneOrJid}:`, error.message);
      throw error;
    }
  }

  /**
   * Disconnect account
   */
  async disconnect(accountId, updateDb = true) {
    const sock = this.connections.get(accountId);
    
    if (sock) {
      try {
        sock.end();
      } catch (e) {
        // Ignore errors during disconnect
      }
      this.connections.delete(accountId);
    }

    // Only update/emit if state actually changed (prevents double events)
    const currentState = this.connectionStates.get(accountId);
    const wasAlreadyDisconnected = currentState?.status === 'disconnected';
    
    this.connectionStates.set(accountId, { status: 'disconnected' });

    if (updateDb && !wasAlreadyDisconnected) {
      await db.updateAccount(accountId, { status: 'disconnected' });
      this.emit('account-status', { accountId, status: 'disconnected' });
      logger.info(`Account ${accountId} disconnected`);
    }
  }

  /**
   * Save session to database with write locking and validation
   */
  async saveSession(accountId) {
    // Check if account still exists
    if (this.deletedAccounts.has(accountId)) {
      logger.debug(`Skipping session save for deleted account ${accountId}`);
      return;
    }

    // Prevent concurrent saves but queue a follow-up if one is pending.
    // creds.update fires rapidly during key exchanges — dropping saves
    // causes Signal pre-key desync which leads to Bad MAC errors.
    if (this.sessionSaveLocks.has(accountId)) {
      // Mark that another save is needed after the current one finishes
      if (!this._pendingSessionSaves) this._pendingSessionSaves = new Set();
      this._pendingSessionSaves.add(accountId);
      logger.debug(`Session save queued for ${accountId} (one already in progress)`);
      return;
    }

    this.sessionSaveLocks.add(accountId);
    try {
      const authPath = path.join(AUTH_STATES_DIR, `session_${accountId}`);
      
      // Check if auth directory exists
      try {
        await fs.access(authPath);
      } catch {
        logger.debug(`Auth path does not exist for account ${accountId}, skipping save`);
        return;
      }

      const files = await fs.readdir(authPath);
      
      if (files.length === 0) {
        logger.debug(`No session files to save for account ${accountId}`);
        return;
      }

      const sessionData = {};
      let credsValid = false;

      for (const file of files) {
        if (file.endsWith('.json')) {
          // Retry read once if parse fails (creds.json may be mid-write)
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const content = await fs.readFile(path.join(authPath, file), 'utf8');
              const parsed = JSON.parse(content);
              sessionData[file] = content;

              if (file === 'creds.json') {
                credsValid = !!(parsed.noiseKey && parsed.signedIdentityKey);
              }
              break; // success
            } catch (readError) {
              if (attempt === 0) {
                // Wait briefly and retry — file may be partially written
                await new Promise(r => setTimeout(r, 150));
              } else {
                logger.warn(`Failed to read/parse session file ${file}: ${readError.message}`);
              }
            }
          }
        }
      }

      if (Object.keys(sessionData).length === 0) {
        logger.debug(`No valid session files to save for account ${accountId}`);
        return;
      }

      // Only save if creds.json was found and has valid identity keys
      if (!sessionData['creds.json'] || !credsValid) {
        logger.warn(`Session for ${accountId} has no valid creds.json, skipping DB save`);
        return;
      }

      const encoded = Buffer.from(JSON.stringify(sessionData)).toString('base64');
      
      await db.updateAccount(accountId, { 
        session_data: encoded,
        last_session_saved: new Date().toISOString()
      });

      logger.debug(`Session saved for account ${accountId} (${Object.keys(sessionData).length} files)`);
    } catch (error) {
      logger.error(`Failed to save session for account ${accountId}:`, error.message);
    } finally {
      this.sessionSaveLocks.delete(accountId);

      // Process any queued save that arrived while we were saving
      if (this._pendingSessionSaves?.has(accountId)) {
        this._pendingSessionSaves.delete(accountId);
        logger.debug(`Processing queued session save for ${accountId}`);
        // Use setImmediate to avoid deep recursion
        setImmediate(() => this.saveSession(accountId));
      }
    }
  }

  /**
   * Restore session from database
   */
  async restoreSession(accountId, sessionData, authPath) {
    try {
      if (!sessionData) {
        logger.debug(`No session data to restore for account ${accountId}`);
        return;
      }

      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(sessionData, 'base64').toString('utf8'));
      } catch (parseError) {
        logger.warn(`Invalid session data format for account ${accountId}, clearing...`);
        await db.updateAccount(accountId, { session_data: null });
        return;
      }

      if (!decoded || typeof decoded !== 'object') {
        logger.warn(`Invalid session data structure for account ${accountId}`);
        return;
      }

      // ===== VALIDATE CREDS BEFORE RESTORING =====
      // Check creds.json for registration status and platform mismatch
      if (decoded['creds.json']) {
        try {
          const creds = JSON.parse(decoded['creds.json']);
          
          // If credentials are not registered, the session is incomplete/stale
          // Restoring it would cause 401 errors instead of generating a fresh QR
          if (creds.registered === false && !creds.me) {
            logger.warn(`Session for ${accountId} has registered=false and no 'me' — incomplete session, discarding`);
            await db.updateAccount(accountId, { session_data: null });
            return;
          }

          // Check for platform mismatch — stored session says one platform
          // but we connect with Browsers.windows('Desktop')
          // A mismatch can cause auth_failure after QR scan
          if (creds.platform && creds.platform !== 'smba' && creds.platform !== 'android') {
            // 'smba' is what Browsers.windows('Desktop') typically produces
            // Allow android too since Baileys can handle it
            logger.debug(`Session platform: ${creds.platform} — acceptable`);
          }

          // If creds have no signalIdentities or account info, session is corrupt
          if (!creds.signedIdentityKey || !creds.noiseKey) {
            logger.warn(`Session for ${accountId} missing critical identity keys, discarding`);
            await db.updateAccount(accountId, { session_data: null });
            return;
          }

          logger.debug(`Session validation passed for ${accountId} (registered: ${creds.registered}, platform: ${creds.platform || 'unknown'})`);
        } catch (credsParseError) {
          logger.warn(`Failed to parse creds.json for validation in ${accountId}, discarding session: ${credsParseError.message}`);
          await db.updateAccount(accountId, { session_data: null });
          return;
        }
      } else {
        // No creds.json in session data — session is useless without it
        logger.warn(`Session data for ${accountId} has no creds.json, discarding`);
        await db.updateAccount(accountId, { session_data: null });
        return;
      }

      // Ensure auth directory exists
      await fs.mkdir(authPath, { recursive: true });

      let restoredCount = 0;
      for (const [filename, content] of Object.entries(decoded)) {
        // Validate filename to prevent path traversal
        if (!filename.endsWith('.json') || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
          logger.warn(`Skipping invalid filename in session data: ${filename}`);
          continue;
        }

        try {
          // Validate content is valid JSON string
          if (typeof content !== 'string') {
            logger.warn(`Invalid content type for ${filename}, skipping`);
            continue;
          }

          await fs.writeFile(path.join(authPath, filename), content, 'utf8');
          restoredCount++;
        } catch (writeError) {
          logger.error(`Failed to write session file ${filename}:`, writeError.message);
        }
      }

      logger.debug(`Session restored for account ${accountId} (${restoredCount} files)`);
    } catch (error) {
      logger.error(`Failed to restore session for account ${accountId}:`, error.message);
      // Don't throw - allow connection to proceed without session (will generate new QR)
    }
  }

  /**
   * Reconnect account (user-initiated)
   */
  async reconnect(accountId) {
    // Debounce: ignore reconnect requests within 5 seconds of each other
    const lastReconnectTime = this.lastReconnectRequest?.get(accountId);
    if (lastReconnectTime && (Date.now() - lastReconnectTime) < 5000) {
      logger.info(`Ignoring rapid reconnect request for ${accountId} (debounce)`);
      return null;
    }
    
    // Track this reconnect request (with auto-cleanup to prevent memory leak)
    if (!this.lastReconnectRequest) {
      this.lastReconnectRequest = new Map();
    }
    this.lastReconnectRequest.set(accountId, Date.now());
    
    // Cleanup old entries (older than 1 minute)
    const now = Date.now();
    for (const [id, time] of this.lastReconnectRequest.entries()) {
      if (now - time > 60000) {
        this.lastReconnectRequest.delete(id);
      }
    }
    
    logger.info(`Manual reconnect requested for account ${accountId}`);
    
    // Clear all tracking to allow fresh connection
    this.reconnectAttempts.delete(accountId);
    this.sessionConflictCounts.delete(accountId);
    this.lastConnectionAttempt.delete(accountId);
    
    // Cancel any pending reconnect timers
    const existingTimer = this.reconnectTimers.get(accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.reconnectTimers.delete(accountId);
    }

    // Wait for any existing connection lock to clear (max 5 seconds)
    let lockWaitAttempts = 0;
    while (this.connectionLocks.has(accountId) && lockWaitAttempts < 10) {
      await new Promise(resolve => setTimeout(resolve, 500));
      lockWaitAttempts++;
    }
    
    // Force clear the lock if still held
    this.connectionLocks.delete(accountId);
    
    await this.disconnect(accountId, false);
    
    // Clear QR code from database to force fresh generation
    await db.updateAccount(accountId, { 
      qr_code: null, 
      error_message: null,
      status: 'initializing'
    }).catch(e => logger.warn(`Failed to clear QR: ${e.message}`));
    
    // Small delay before reconnecting to ensure clean state
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return this.connect(accountId);
  }

  /**
   * Get QR code for account
   */
  async getQrCode(accountId) {
    // First check runtime state (most up-to-date)
    const state = this.connectionStates.get(accountId);
    if (state?.qr) {
      return state.qr;
    }

    // Fallback to database
    const account = await db.getAccountById(accountId);
    return account?.qr_code || null;
  }

  /**
   * Regenerate API key
   */
  async regenerateApiKey(accountId) {
    const newApiKey = this.generateApiKey();
    await db.updateAccount(accountId, { api_key: newApiKey });
    return newApiKey;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down WhatsApp manager...');
    
    // Set shutdown flag to prevent reconnection attempts
    this.isShuttingDown = true;

    // Stop health monitor
    if (this._healthMonitorInterval) {
      clearInterval(this._healthMonitorInterval);
      this._healthMonitorInterval = null;
    }
    
    // Cancel all pending reconnection timers
    for (const [accountId, timer] of this.reconnectTimers) {
      clearTimeout(timer);
      logger.debug(`Cancelled reconnect timer for ${accountId}`);
    }
    this.reconnectTimers.clear();
    
    // Cancel all watchdog timers
    for (const [accountId, watchdog] of this.connectionWatchdogs) {
      clearTimeout(watchdog);
    }
    this.connectionWatchdogs.clear();

    // Persist LID mappings one last time
    await this._persistLidMappings();
    
    // Disconnect all accounts gracefully
    for (const [accountId, sock] of this.connections) {
      try {
        await this.saveSession(accountId);
        sock.end();
      } catch (e) {
        // Ignore errors during shutdown
      }
    }

    this.connections.clear();
    this.connectionStates.clear();
    this.connectionLocks.clear();
    this.sessionConflictCounts.clear();
    this.reconnectAttempts.clear();
    this.lastReconnectRequest?.clear();
    
    logger.info('WhatsApp manager shutdown complete');
  }
}

// Export singleton instance
module.exports = new WhatsAppManager();
