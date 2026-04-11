/**
 * WhatsApp Manager - Baileys Version
 * Core module for managing WhatsApp connections using @whiskeysockets/baileys
 * No browser/Chromium required - uses WebSocket protocol
 */

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidDecode, jidNormalizedUser, Browsers, downloadMediaMessage, getContentType, proto, isJidBroadcast, isJidNewsletter, isJidStatusBroadcast } = require('@whiskeysockets/baileys');
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
// PLATFORM FIX: WhatsApp rejects Platform.WEB (value 14) since Feb 2026.
// Baileys hardcodes Platform.WEB in validate-connection.ts, but WA servers now
// require Platform.MACOS (value 24). PR #2365 fixes this in Baileys source but
// hasn't been merged yet. Monkey-patch the proto enum so Baileys sends MACOS.
// CAVEAT: Newsletters may not work with MACOS platform, but we already skip
// newsletters via shouldIgnoreJid, so this is acceptable.
// TODO: Remove this patch once Baileys merges PR #2365.
// ============================================================================
if (proto?.ClientPayload?.UserAgent?.Platform && proto.ClientPayload.UserAgent.Platform.WEB === 14) {
  proto.ClientPayload.UserAgent.Platform.WEB = 24; // Remap WEB → MACOS value
  // Update reverse mapping so protobuf serialization works correctly
  proto.ClientPayload.UserAgent.Platform[24] = 'WEB';
}

// ============================================================================
// CONFIGURATION (libsignal noise handled by silent pino logger)
// ============================================================================

const AUTH_STATES_DIR = path.join(__dirname, '..', 'auth_states');

// Message retry counter cache
// Baileys uses this to track CIPHERTEXT retry attempts per message.
// Phase 1 (retryCount=1): Asks the phone to re-send via PDO — takes 20s,
//   fails if phone is offline, and doesn't fix the underlying session issue.
// Phase 2 (retryCount>1): Sends our pre-keys directly to the sender, who
//   establishes a fresh session and re-sends — this is far more reliable.
// We patch get() to return at least 1, so retries always start in Phase 2,
// skipping the unreliable PDO approach entirely. This resolves CIPHERTEXT
// errors much faster and doesn't depend on the phone being online.
const msgRetryCounterCache = new NodeCache({ stdTTL: 600, checkperiod: 60 });
const _origMsgRetryGet = msgRetryCounterCache.get.bind(msgRetryCounterCache);
msgRetryCounterCache.get = (key) => {
  const val = _origMsgRetryGet(key);
  return typeof val === 'number' ? val : 1;
};

// ============================================================================
// WA VERSION CACHE
// ============================================================================
// fetchLatestBaileysVersion() makes an HTTP request to WhatsApp's endpoint.
// Calling it on every connect() creates unnecessary traffic and latency.
// Cache the result for 6 hours — versions change infrequently.
// ============================================================================
let _cachedWaVersion = null;
let _cachedWaVersionTime = 0;
const WA_VERSION_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function getCachedWaVersion() {
  const now = Date.now();
  if (_cachedWaVersion && (now - _cachedWaVersionTime) < WA_VERSION_CACHE_TTL) {
    return _cachedWaVersion;
  }
  try {
    const result = await fetchLatestBaileysVersion();
    _cachedWaVersion = result.version;
    _cachedWaVersionTime = now;
    return _cachedWaVersion;
  } catch (err) {
    // If fetch fails but we have a stale cache, use it
    if (_cachedWaVersion) {
      return _cachedWaVersion;
    }
    throw err;
  }
}

// ============================================================================
// MESSAGE STORE FOR RETRY SYSTEM
// ============================================================================
// Baileys needs getMessage() to return real message content for its retry
// mechanism (when WA server requests a message re-send for decryption).
// Without this, retries fail silently and messages can't be decrypted.
// We keep a bounded LRU-style cache of recently sent/received messages.
//
// CRITICAL: getMessage() must return proto.IMessage (the .message property),
// NOT the full WAMessage object. Returning the wrong type causes Baileys to
// fail silently during Signal session renegotiation.
// See: lettabot PR #358, Baileys #1767
// ============================================================================
const MESSAGE_STORE_MAX = 10000;
const MESSAGE_STORE_PERSIST_MAX = 1000; // Only persist the most recent N for disk
const messageStore = new Map(); // key: `${remoteJid}|${msgId}` → proto.Message
const messageIdIndex = new Map(); // key: msgId → storeKey (for fallback lookup)
let messageStoreDirty = false;
let messageStoreSaveTimer = null;
const MESSAGE_STORE_SAVE_INTERVAL = 30000; // Persist to disk every 30s if dirty

function storeMessage(key, message) {
  if (!key?.id || !message) return;
  const storeKey = `${key.remoteJid}|${key.id}`;
  messageStore.set(storeKey, message);
  messageIdIndex.set(key.id, storeKey);
  messageStoreDirty = true;
  // Evict oldest entries when either map grows too large
  if (messageStore.size > MESSAGE_STORE_MAX) {
    const firstKey = messageStore.keys().next().value;
    const firstMsgId = firstKey.split('|')[1];
    messageStore.delete(firstKey);
    messageIdIndex.delete(firstMsgId);
  }
  if (messageIdIndex.size > MESSAGE_STORE_MAX + 1000) {
    // Safety cap — trim stale index entries not in messageStore
    for (const [mid, sk] of messageIdIndex) {
      if (!messageStore.has(sk)) messageIdIndex.delete(mid);
    }
  }
}

function getStoredMessage(key) {
  if (!key?.id) return undefined;
  
  // Primary lookup: exact remoteJid + msgId match
  const storeKey = `${key.remoteJid}|${key.id}`;
  const exact = messageStore.get(storeKey);
  if (exact) return exact;
  
  // Fallback: lookup by just message ID
  // This handles LID/PN addressing inversion — message was stored with
  // one JID format but retry request comes with a different format
  const fallbackKey = messageIdIndex.get(key.id);
  if (fallbackKey) {
    return messageStore.get(fallbackKey);
  }
  
  return undefined;
}

// ── Persist message store to disk for retry survival across restarts ──
// Only the most recent MESSAGE_STORE_PERSIST_MAX entries are saved.
async function saveMessageStoreToDisk() {
  if (!messageStoreDirty) return;
  try {
    const storePath = path.join(__dirname, '..', 'data', 'message-store.json');
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    // Take the last N entries from messageStore
    const entries = Array.from(messageStore.entries());
    const recent = entries.slice(-MESSAGE_STORE_PERSIST_MAX);
    const serializable = recent.map(([k, v]) => {
      try {
        return [k, proto.Message.toObject(v, { defaults: false })];
      } catch {
        return null;
      }
    }).filter(Boolean);
    await fs.writeFile(storePath, JSON.stringify(serializable), 'utf8');
    messageStoreDirty = false;
    logger.debug(`[MSG-STORE] Persisted ${serializable.length} messages to disk`);
  } catch (err) {
    logger.warn(`[MSG-STORE] Failed to persist message store: ${err.message}`);
  }
}

async function loadMessageStoreFromDisk() {
  try {
    const storePath = path.join(__dirname, '..', 'data', 'message-store.json');
    const data = await fs.readFile(storePath, 'utf8');
    const entries = JSON.parse(data);
    let loaded = 0;
    for (const [k, v] of entries) {
      try {
        const msg = proto.Message.fromObject(v);
        messageStore.set(k, msg);
        const msgId = k.split('|')[1];
        if (msgId) messageIdIndex.set(msgId, k);
        loaded++;
      } catch {
        // Skip entries that can't be deserialized
      }
    }
    logger.info(`[MSG-STORE] Loaded ${loaded} messages from disk for retry support`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn(`[MSG-STORE] Failed to load message store: ${err.message}`);
    }
  }
}

function startMessageStorePersistence() {
  if (messageStoreSaveTimer) return;
  messageStoreSaveTimer = setInterval(() => {
    saveMessageStoreToDisk().catch(() => {});
  }, MESSAGE_STORE_SAVE_INTERVAL);
  // Don't keep process alive just for this timer
  if (messageStoreSaveTimer.unref) messageStoreSaveTimer.unref();
}

function stopMessageStorePersistence() {
  if (messageStoreSaveTimer) {
    clearInterval(messageStoreSaveTimer);
    messageStoreSaveTimer = null;
  }
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
 * Pick a browser fingerprint per account (stored in memory)
 * CRITICAL: Only use Baileys' built-in Browsers helpers.
 * Custom browser strings (e.g. ['Windows', 'Chrome', ...]) produce device
 * fingerprints that don't match any real WhatsApp Web client — WhatsApp's
 * server-side detection flags these as unofficial clients, leading to bans.
 * The Browsers.* helpers generate the exact platform/app/version tuples
 * that real WhatsApp Web sends.
 */
const BROWSER_PROFILES = [
  () => Browsers.windows('Desktop'),
  () => Browsers.macOS('Desktop'),
  () => Browsers.appropriate('Desktop'),
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
    this.maxReconnectAttempts = 3; // Reduced from 5 — fewer retry cycles = less ban risk
    this.maxSessionConflicts = 3; // Max 440 errors before requiring manual reconnect
    this.minReconnectInterval = 120000; // Minimum 120s between reconnections (doubled for safety)
    this.qrTimeoutMs = 60000; // QR code generation timeout (60 seconds)
    this.sessionSaveTimers = new Map(); // Debounced session save timers per account
    this.SESSION_SAVE_DEBOUNCE_MS = 3000; // Save session to DB at most once per 3s (reduced from 5s to narrow the data-loss window on ephemeral filesystems — signal key loss → CIPHERTEXT → ban)
    this.periodicSessionSaveTimers = new Map(); // Periodic save timers per account
    this.PERIODIC_SESSION_SAVE_MS = 60000; // Save session to DB every 60s as safety net
    this.lastSessionHashes = new Map(); // Track last saved session hash to skip redundant writes
    // NOTE: assertSessions was removed from the CIPHERTEXT handler — Baileys
    // has its own retry mechanism (sendRetryRequest) that handles decryption
    // failures internally. Calling assertSessions() force-resets the Signal
    // session, destroying the ratchet state that Baileys needs for its retry
    // negotiation — this was causing the "works once then fails" pattern.
    // Outgoing message rate limiter — prevents burst-sending patterns
    // that WhatsApp's detection systems flag as automation.
    // Sliding window: max 20 messages per 60s per account (reduced from 30 —
    // 30/min is detectable; 20/min stays below Meta's per-minute threshold).
    this.messageSendTimestamps = new Map(); // accountId -> number[]
    this.MAX_MESSAGES_PER_WINDOW = 20;
    this.MESSAGE_WINDOW_MS = 60000;
    // Hourly rate limiter — secondary guard against sustained high-volume sending.
    // Meta's detection works on session-level, hourly, and daily buckets.
    // 80/hour ≈ 1.3/min average leaves room for bursts while avoiding daily limits.
    this.messageSendTimestampsHourly = new Map(); // accountId -> number[]
    this.MAX_MESSAGES_PER_HOUR = 80;
    this.MESSAGE_WINDOW_HOURLY_MS = 60 * 60 * 1000;
    // Message send serialization — prevents concurrent sends that create
    // chaotic presence state (two composing states fighting each other).
    // Every send is queued per account and executed serially.
    this.sendQueues = new Map(); // accountId -> Promise chain
    // Minimum gap enforced INSIDE the queue after each send.
    // Even short messages need some breathing room between sends.
    this.MIN_SEND_INTERVAL_MS = 3000; // 3 seconds floor
    this.lastSendTimestamp = new Map(); // accountId -> last send timestamp
    // Active conversation tracking per JID — avoids the mechanical
    // available→unavailable toggle for every single message.
    // Within an active conversation window we skip the global 'available' step
    // and defer going 'unavailable' much longer.
    this.lastMessagePerJid = new Map(); // "accountId:jid" -> last outbound timestamp
    this.ACTIVE_CONVO_WINDOW_MS = 45000; // 45 seconds = in an active conversation
    // onWhatsApp() rate limiter — Meta heavily monitors number-existence checks.
    // Excessive calls trigger "number enumeration" detection → permanent ban.
    this.onWhatsAppTimestamps = new Map(); // accountId -> number[]
    this.MAX_ON_WHATSAPP_PER_WINDOW = 8; // max 8 checks per 60s per account
    this.ON_WHATSAPP_WINDOW_MS = 60000;
    this.onWhatsAppCache = new Map(); // "accountId:number" -> { jid, lid, exists, ts }
    this.ON_WHATSAPP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h cache for existence checks
    // AI auto-reply loop breaker — prevents infinite exchange between AI-enabled accounts
    this.aiReplyTracker = new Map(); // "accountId:contactId" -> { count, firstReplyTs }
    this.AI_REPLY_MAX_PER_CONTACT = 3; // max consecutive AI replies to same contact
    this.AI_REPLY_WINDOW_MS = 5 * 60 * 1000; // 5-minute window for counting replies
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

    // Memory cleanup interval — evicts stale entries from unbounded Maps
    // to prevent OOM crashes that trigger reconnection storms → ban risk.
    this._memoryCleanupInterval = null;
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

    // Exponential backoff for 440: 120s, 240s, 480s with jitter
    // Starts at 120s (not 60s) to match the safer general reconnect timing.
    // Session conflicts are especially dangerous — rapid retry after 440 is a
    // strong ban signal because it looks like two clients fighting for control.
    const baseDelay = 120000 * Math.pow(2, conflictCount - 1);
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
   * CRITICAL FIX: Always send to @s.whatsapp.net (phone JID), NEVER to @lid.
   *
   * On Baileys v6.7.21, LID-based sending is broken because:
   * 1. LID/PN transaction race conditions corrupt Signal session ratchets
   *    (concurrent encrypt/decrypt ops on PN and LID for same contact use
   *    different mutex keys → Bad MAC / Failed to decrypt)
   * 2. migrateSession() aggressively deletes PN sessions when copying to LID,
   *    causing in-flight PN messages to fail with "No matching session"
   * 3. Signal sessions are established on @s.whatsapp.net but we were
   *    encrypting for @lid → recipient can't decrypt → "Waiting for message"
   *
   * See: Baileys #1767, #1769, #1964, #2340, #2372
   *
   * Supports: phone numbers, LIDs, phone@s.whatsapp.net, lid@lid, group@g.us
   */
  async resolveRecipientJid(accountId, to) {
    if (!to || typeof to !== 'string') {
      throw new Error('Invalid recipient: must be a non-empty string');
    }
    
    const trimmed = to.trim();
    
    // Already has a JID suffix — handle each format
    if (trimmed.includes('@')) {
      // Group JIDs — pass through unchanged
      if (trimmed.endsWith('@g.us') || trimmed.endsWith('@broadcast') || trimmed.endsWith('@newsletter')) {
        return trimmed;
      }
      
      // If it's an @lid JID, convert to phone JID if we have the mapping
      // LID-based sending causes "Waiting for message" on Baileys v6.7.21
      if (trimmed.endsWith('@lid')) {
        const lidNumber = trimmed.split('@')[0];
        const phoneFromLid = this.lidToPhone.get(lidNumber);
        if (phoneFromLid) {
          logger.info(`[RESOLVE] Converting @lid JID to phone JID: ${lidNumber}@lid → ${phoneFromLid}@s.whatsapp.net (LID sending broken on v6)`);
          return `${phoneFromLid}@s.whatsapp.net`;
        }
        // No mapping — try rate-limited onWhatsApp to find the phone number
        const result = await this._safeOnWhatsApp(accountId, lidNumber);
        if (result?.exists && result?.jid) {
          const phoneJid = result.jid.endsWith('@s.whatsapp.net') ? result.jid : `${result.jid.split('@')[0]}@s.whatsapp.net`;
          if (result.lid) this.registerLidPhoneMapping(result.lid, phoneJid);
          logger.info(`[RESOLVE] Resolved @lid via onWhatsApp: ${lidNumber}@lid → ${phoneJid}`);
          return phoneJid;
        }
        // Never send to @lid. Baileys v6 can produce undecryptable messages
        // and "Waiting for message" when the phone JID is unknown.
        throw new Error(`Cannot send to unresolved LID ${lidNumber}. Wait for a phone mapping before replying.`);
      }
      
      // @s.whatsapp.net — pass through (already phone format)
      return trimmed;
    }
    
    // Bare number — need to figure out the correct JID format
    const cleaned = trimmed.replace(/[^0-9]/g, '');
    if (!cleaned) {
      throw new Error('Invalid recipient: no digits found');
    }
    
    // 1. Check if this number is a known LID number → resolve to PHONE JID
    const phoneFromLid = this.lidToPhone.get(cleaned);
    if (phoneFromLid) {
      logger.info(`[RESOLVE] ${cleaned} is a known LID → phone ${phoneFromLid}, sending to phone JID (LID sending disabled)`);
      return `${phoneFromLid}@s.whatsapp.net`;
    }
    
    // 2. This is a phone number — ALWAYS send to @s.whatsapp.net
    //    (Do NOT redirect to LID even if mapping exists — LID sending is broken)
    
    // 3. Try rate-limited onWhatsApp() to verify the number exists
    const result = await this._safeOnWhatsApp(accountId, cleaned);
    if (result?.exists) {
      // Register LID mapping for future reference (but don't USE the LID for sending)
      if (result.lid) {
        this.registerLidPhoneMapping(result.lid, result.jid);
      }
      // Always use the phone JID, never the LID
      const phoneJid = result.jid.endsWith('@s.whatsapp.net') ? result.jid : `${result.jid.split('@')[0]}@s.whatsapp.net`;
      logger.info(`[RESOLVE] ${cleaned} verified on WhatsApp → ${phoneJid} (LID: ${result.lid || 'none'}, using phone JID)`);
      return phoneJid;
    }
    
    // 4. Fallback: assume it's a phone number
    logger.info(`[RESOLVE] ${cleaned} not verified, assuming phone number → ${cleaned}@s.whatsapp.net`);
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
   * Check if account has exceeded outgoing message rate limit.
   * Sliding window: MAX_MESSAGES_PER_WINDOW messages per MESSAGE_WINDOW_MS.
   * Also enforces a secondary hourly cap (MAX_MESSAGES_PER_HOUR).
   * Prevents burst-sending patterns that WhatsApp flags as automation.
   */
  _checkSendRateLimit(accountId) {
    const now = Date.now();
    let timestamps = this.messageSendTimestamps.get(accountId);
    if (!timestamps) {
      timestamps = [];
      this.messageSendTimestamps.set(accountId, timestamps);
    }
    // Evict expired per-minute timestamps
    const cutoff = now - this.MESSAGE_WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= this.MAX_MESSAGES_PER_WINDOW) {
      return false; // per-minute rate limited
    }

    // Hourly cap — catch sustained high-volume sending that bypasses per-minute limits
    let hourlyTimestamps = this.messageSendTimestampsHourly.get(accountId);
    if (!hourlyTimestamps) {
      hourlyTimestamps = [];
      this.messageSendTimestampsHourly.set(accountId, hourlyTimestamps);
    }
    const hourlyCutoff = now - this.MESSAGE_WINDOW_HOURLY_MS;
    while (hourlyTimestamps.length > 0 && hourlyTimestamps[0] <= hourlyCutoff) {
      hourlyTimestamps.shift();
    }
    if (hourlyTimestamps.length >= this.MAX_MESSAGES_PER_HOUR) {
      logger.warn(`[RATE-LIMIT] Account ${accountId} hit hourly cap (${hourlyTimestamps.length}/${this.MAX_MESSAGES_PER_HOUR} per hour)`);
      return false; // hourly rate limited
    }

    timestamps.push(now);
    hourlyTimestamps.push(now);
    return true; // allowed
  }

  /**
   * Serialize outbound sends per account via a promise chain.
   * This prevents concurrent API calls from fighting over the same presence
   * state (two messages both trying to set composing→paused→send at the same
   * time, resulting in near-simultaneous sends that look like bulk messaging).
   *
   * Usage: return this._enqueueSend(accountId, async () => { ...send logic... });
   */
  _enqueueSend(accountId, fn) {
    const prev = this.sendQueues.get(accountId) || Promise.resolve();
    // Run fn regardless of whether the previous item succeeded or failed.
    const next = prev.then(() => fn(), () => fn());
    // Store a non-rejecting tail so the chain never permanently breaks.
    this.sendQueues.set(accountId, next.catch(() => {}));
    return next; // Propagate actual result/error to the caller.
  }

  /**
   * Rate-limited & cached onWhatsApp() call.
   * Meta treats excessive onWhatsApp() as number enumeration → PERMANENT BAN.
   * This wrapper enforces a sliding window (8 calls/60s) and caches results for 24h.
   */
  async _safeOnWhatsApp(accountId, number) {
    const cacheKey = `${accountId}:${number}`;
    const cached = this.onWhatsAppCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < this.ON_WHATSAPP_CACHE_TTL_MS) {
      return cached;
    }

    // Rate limit check
    const now = Date.now();
    let timestamps = this.onWhatsAppTimestamps.get(accountId);
    if (!timestamps) {
      timestamps = [];
      this.onWhatsAppTimestamps.set(accountId, timestamps);
    }
    const cutoff = now - this.ON_WHATSAPP_WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= this.MAX_ON_WHATSAPP_PER_WINDOW) {
      logger.warn(`[RESOLVE] onWhatsApp rate limit hit for account ${accountId} (${timestamps.length}/${this.MAX_ON_WHATSAPP_PER_WINDOW} per ${this.ON_WHATSAPP_WINDOW_MS / 1000}s)`);
      return null; // rate limited — return null, caller should use fallback
    }

    const sock = this.connections.get(accountId);
    if (!sock) return null;

    timestamps.push(now);
    try {
      const [result] = await sock.onWhatsApp(number) || [];
      if (result) {
        const entry = { jid: result.jid, lid: result.lid || null, exists: !!result.exists, ts: now };
        this.onWhatsAppCache.set(cacheKey, entry);
        // Evict old cache entries periodically
        if (this.onWhatsAppCache.size > 5000) {
          for (const [k, v] of this.onWhatsAppCache) {
            if (now - v.ts > this.ON_WHATSAPP_CACHE_TTL_MS) this.onWhatsAppCache.delete(k);
          }
        }
        return entry;
      }
    } catch (err) {
      logger.debug(`[RESOLVE] onWhatsApp failed for ${number}: ${err.message}`);
    }
    return null;
  }

  /**
   * Check if AI auto-reply is allowed for this contact (loop prevention).
   * Returns true if reply is allowed, false if loop limit reached.
   */
  _checkAiReplyAllowed(accountId, contactId) {
    const key = `${accountId}:${contactId}`;
    const now = Date.now();
    let tracker = this.aiReplyTracker.get(key);

    if (!tracker || (now - tracker.firstReplyTs) > this.AI_REPLY_WINDOW_MS) {
      // Window expired or first reply — start fresh
      tracker = { count: 1, firstReplyTs: now };
      this.aiReplyTracker.set(key, tracker);
      return true;
    }

    if (tracker.count >= this.AI_REPLY_MAX_PER_CONTACT) {
      logger.warn(`[AI] Loop guard: blocked AI reply to ${contactId} for account ${accountId} (${tracker.count} replies in ${Math.round((now - tracker.firstReplyTs) / 1000)}s)`);
      return false;
    }

    tracker.count++;
    return true;
  }

  /**
   * Reset AI reply counter when a HUMAN message is received from a contact.
   * (A human sending a new message breaks the AI-AI loop.)
   */
  _resetAiReplyCounter(accountId, contactId) {
    this.aiReplyTracker.delete(`${accountId}:${contactId}`);
  }

  /**
   * Initialize all accounts from database
   */
  async initializeAccounts() {
    try {
      // Load persisted message store for retry survival across restarts
      await loadMessageStoreFromDisk();
      startMessageStorePersistence();

      // Load persisted LID mappings before connecting accounts
      await this._loadLidMappings();

      const accounts = await db.getAccounts();
      const toConnect = accounts.filter(a => a.status === 'ready' || a.session_data);

      // CRITICAL: Randomize connection order. Connecting accounts in the same
      // order (alphabetical, creation-date, etc.) on every restart is a detectable
      // pattern. WhatsApp's systems flag IPs that show identical connection sequences.
      // Fisher-Yates shuffle for unbiased randomization.
      for (let i = toConnect.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [toConnect[i], toConnect[j]] = [toConnect[j], toConnect[i]];
      }

      logger.info(`Found ${accounts.length} accounts, ${toConnect.length} to initialize (randomized order)`);

      for (let i = 0; i < toConnect.length; i++) {
        const account = toConnect[i];
        try {
          await this.connect(account.id);
        } catch (e) {
          logger.error(`Failed to initialize account ${account.id}: ${e.message}`);
        }
        // Stagger connections to avoid hitting WhatsApp servers all at once
        // Increased delay — multiple accounts connecting rapidly from the same IP
        // is a strong ban signal in WhatsApp's detection systems.
        // Scale delay with account count: 10+ accounts need longer intervals.
        if (i < toConnect.length - 1) {
          const baseMin = toConnect.length >= 10 ? 25000 : 8000;
          const baseMax = toConnect.length >= 10 ? 45000 : 15000;
          const staggerDelay = humanDelay(baseMin, baseMax);
          logger.debug(`Waiting ${staggerDelay}ms before next account initialization (${i + 1}/${toConnect.length})`);
          await new Promise(resolve => setTimeout(resolve, staggerDelay));
        }
      }

      // Start periodic health monitor after all accounts initialized
      this._startHealthMonitor();

      // Start memory cleanup to prevent OOM → reconnection storms → ban
      this._startMemoryCleanup();
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
    // Run every 10 minutes (reduced aggressiveness — too-frequent health checks
    // that trigger reconnects create abnormal connection patterns)
    const HEALTH_CHECK_INTERVAL = 10 * 60 * 1000;
    // Max time an account can be in 'reconnecting' state before forced action
    const MAX_RECONNECTING_MS = 15 * 60 * 1000;

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
              this.scheduleReconnect(account.id, humanDelay(30000, 60000));
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
          // CRITICAL: Check total attempts INCLUDING health monitor cycles.
          // Previously, the health monitor could re-trigger reconnects indefinitely
          // (every 10min) even after maxReconnectAttempts was reached in the
          // connection handler, because the counter was only checked/set here locally.
          // This created a persistent reconnection pattern that WhatsApp detects.
          if (state?.status === 'error' && hasSession) {
            const attempts = this.reconnectAttempts.get(account.id) || 0;
            // Only auto-heal if TOTAL attempts (including health monitor) are under limit
            if (attempts < this.maxReconnectAttempts) {
              logger.info(`[HEALTH] Account ${account.id} in error state with valid session, attempting recovery (attempt ${attempts + 1}/${this.maxReconnectAttempts})`);
              this.reconnectAttempts.set(account.id, attempts + 1);
              // Use longer delays for health-monitor-triggered reconnects (60-120s)
              // to avoid rapid reconnection patterns
              this.scheduleReconnect(account.id, humanDelay(60000, 120000));
            } else {
              logger.info(`[HEALTH] Account ${account.id} in error state but max reconnect attempts (${this.maxReconnectAttempts}) reached — requires manual reconnect`);
            }
          }
        }
      } catch (err) {
        logger.error(`[HEALTH] Health monitor error: ${err.message}`);
      }
    }, HEALTH_CHECK_INTERVAL);

    // Don't prevent process exit
    this._healthMonitorInterval.unref?.();
    logger.info('[HEALTH] Connection health monitor started (10 min interval)');
  }

  // ============================================================================
  // MEMORY CLEANUP
  // ============================================================================
  // Periodically evicts stale entries from in-memory Maps that grow unbounded.
  // Without this, long-running instances accumulate entries in lastMessagePerJid,
  // messageSendTimestamps, onWhatsAppCache, aiReplyTracker, recentMessageHashes,
  // etc. Eventually this causes OOM → container kill → all accounts disconnect
  // and reconnect simultaneously from the same IP → ban.
  // ============================================================================
  _startMemoryCleanup() {
    if (this._memoryCleanupInterval) return;
    const CLEANUP_INTERVAL = 5 * 60 * 1000; // Every 5 minutes

    this._memoryCleanupInterval = setInterval(() => {
      const now = Date.now();
      let evicted = 0;

      // Clean lastMessagePerJid — entries older than 5 minutes are dead conversations
      for (const [key, ts] of this.lastMessagePerJid) {
        if (now - ts > 5 * 60 * 1000) {
          this.lastMessagePerJid.delete(key);
          evicted++;
        }
      }

      // Clean messageSendTimestamps — remove per-account lists with all-expired entries
      for (const [accountId, timestamps] of this.messageSendTimestamps) {
        const cutoff = now - this.MESSAGE_WINDOW_MS;
        while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
        if (timestamps.length === 0) {
          this.messageSendTimestamps.delete(accountId);
          evicted++;
        }
      }
      for (const [accountId, timestamps] of this.messageSendTimestampsHourly) {
        const cutoff = now - this.MESSAGE_WINDOW_HOURLY_MS;
        while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
        if (timestamps.length === 0) {
          this.messageSendTimestampsHourly.delete(accountId);
          evicted++;
        }
      }

      // Clean onWhatsApp timestamps
      for (const [accountId, timestamps] of this.onWhatsAppTimestamps) {
        const cutoff = now - this.ON_WHATSAPP_WINDOW_MS;
        while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
        if (timestamps.length === 0) {
          this.onWhatsAppTimestamps.delete(accountId);
          evicted++;
        }
      }

      // Clean onWhatsApp cache — evict entries older than TTL
      for (const [key, entry] of this.onWhatsAppCache) {
        if (now - entry.ts > this.ON_WHATSAPP_CACHE_TTL_MS) {
          this.onWhatsAppCache.delete(key);
          evicted++;
        }
      }

      // Clean AI reply tracker — evict expired windows
      for (const [key, tracker] of this.aiReplyTracker) {
        if (now - tracker.firstReplyTs > this.AI_REPLY_WINDOW_MS) {
          this.aiReplyTracker.delete(key);
          evicted++;
        }
      }

      // Clean recentMessageHashes
      for (const [key, ts] of recentMessageHashes) {
        if (now - ts > DUPLICATE_WINDOW_MS) {
          recentMessageHashes.delete(key);
          evicted++;
        }
      }

      // Clean lastSendTimestamp — remove entries for disconnected accounts
      for (const [accountId] of this.lastSendTimestamp) {
        if (!this.connections.has(accountId)) {
          this.lastSendTimestamp.delete(accountId);
          evicted++;
        }
      }

      if (evicted > 0) {
        logger.debug(`[MEMORY] Cleaned ${evicted} stale entries from in-memory maps`);
      }
    }, CLEANUP_INTERVAL);

    this._memoryCleanupInterval.unref?.();
    logger.info('[MEMORY] Memory cleanup started (5 min interval)');
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

      // Cancel any pending debounced session save
      const saveTimer = this.sessionSaveTimers.get(accountId);
      if (saveTimer) {
        clearTimeout(saveTimer);
        this.sessionSaveTimers.delete(accountId);
      }

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
      // and we fall through to a fresh QR code flow.
      // SKIP restore if auth files already exist on disk (same-process reconnect,
      // e.g. after QR scan). Disk files are more up-to-date than DB because
      // creds.update events may have fired after the last DB save.
      const authFilesExist = await fs.access(path.join(authPath, 'creds.json')).then(() => true).catch(() => false);
      if (account.session_data && !authFilesExist) {
        await this.restoreSession(accountId, account.session_data, authPath);
      } else if (authFilesExist) {
        logger.debug(`Auth files already on disk for ${accountId}, skipping DB restore`);
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

      // ── Wrap key store to detect Signal key changes ──
      // CRITICAL: useMultiFileAuthState writes signal keys (sessions, pre-keys,
      // sender-keys) to disk but does NOT trigger creds.update. Without this
      // wrapper, signal key changes are NEVER persisted to the database.
      // On ephemeral filesystems (Render), this means ALL signal sessions are
      // lost on restart → CIPHERTEXT errors for every contact.
      // This wrapper intercepts keys.set() to schedule a debounced DB save
      // after each burst of signal key operations.
      const originalKeysSet = state.keys.set.bind(state.keys);
      state.keys.set = async (data) => {
        await originalKeysSet(data);
        // Schedule debounced session save — key operations come in bursts
        // during session establishment, so we debounce to avoid write storms
        this._scheduleSessionSave(accountId);
      };

      // Get latest Baileys version (with fallback)
      let version;
      try {
        version = await getCachedWaVersion();
      } catch (versionErr) {
        logger.warn(`Failed to fetch Baileys version, using fallback: ${versionErr.message}`);
        version = [2, 3000, 1034740716];
      }

      // Logger for Baileys — warn level so Signal key store errors are visible
      const baileysLogger = pino({ level: 'warn' });

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
        // MUST return proto.IMessage (not WAMessage), or undefined.
        // See: Baileys #1767, lettabot PR #358
        getMessage: async (key) => {
          const stored = getStoredMessage(key);
          if (stored) {
            logger.info(`[RETRY] getMessage() found stored message for retry: msgId=${key.id}, remoteJid=${key.remoteJid}`);
            return stored;
          }
          logger.warn(`[RETRY] getMessage() MISS — no stored message for msgId=${key.id}, remoteJid=${key.remoteJid}. Recipient will see "Waiting for message".`);
          return undefined;
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
        qrTimeout: 55000, // Aligned closer to watchdog timeout (60s) to prevent mismatch
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        // Patch-based presence to reduce detection surface
        patchMessageBeforeSending: (message) => {
          // Don't modify — just pass through. Having the handler
          // registered prevents Baileys from adding its own metadata
          return message;
        },
        // Firewall / keep-alive tuning — add jitter to avoid perfectly periodic pings
        keepAliveIntervalMs: 20000 + Math.floor(Math.random() * 10000), // 20-30s like real WA Web
        // Slower retry delay — 250ms was too fast and generated abnormal traffic.
        retryRequestDelayMs: 500,
        // Keep message retry count conservative — fewer retries = less retry traffic.
        // 3 attempts covers the common pre-key depletion scenario without excess noise.
        maxMsgRetryCount: 3,
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
          logger.info(`Post-QR-scan restart for ${accountId} (status ${statusCode}), saving session then reconnecting`);
          this.connectionStates.set(accountId, { status: 'reconnecting' });

          // CRITICAL: Save session to DB immediately after QR scan (don't debounce).
          // This is a first-time auth — if the server crashes between QR scan and
          // reconnect, an unsaved session forces the user to scan QR again.
          await this.saveSession(accountId).catch(e =>
            logger.warn(`Post-pair session save failed: ${e.message}`)
          );

          await db.updateAccount(accountId, {
            status: 'initializing',
            qr_code: null,
            error_message: null
          }).catch(e => logger.warn(`Failed to update account status: ${e.message}`));
          this.emit('account-status', { accountId, status: 'reconnecting', message: 'QR scanned, reconnecting...' });

          // CRITICAL: Clear rate limiter so the post-pair reconnect isn't
          // blocked by the 120s minReconnectInterval. The initial connect()
          // set lastConnectionAttempt just 20-60s ago (while QR was showing),
          // and now isNewAccount=false (session was saved). Without this clear,
          // the reconnect would be delayed 60-100s, causing WA server to
          // abandon the pairing and show an error on the phone.
          this.lastConnectionAttempt.delete(accountId);
          
          // Wait 3 seconds for WA servers to process the new session.
          // 6s was too conservative — WA expects the client back within ~5s.
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

        // Status 405 = Method Not Allowed — WhatsApp rejected the client payload
        // (platform/version mismatch). Don't auto-reconnect with the same config;
        // the session needs a fresh start with correct platform identification.
        if (statusCode === 405) {
          logger.error(`Platform/version rejected (405) for ${accountId} — WhatsApp rejected client payload`);
          this.connectionStates.set(accountId, { status: 'error', error: 'Platform rejected by WhatsApp' });
          await db.updateAccount(accountId, {
            status: 'error',
            error_message: 'WhatsApp rejected the connection (405). Please try reconnecting — the app will use updated platform settings.'
          }).catch(e => logger.warn(`Failed to update account: ${e.message}`));
          this.emit('account-status', { accountId, status: 'error', message: 'Platform rejected — click Reconnect' });
          return;
        }

        // Status 409 = Conflict — another instance is using this session.
        // Treat like 440 (session conflict) but don't count toward conflict limit
        // since 409 is a one-off server-side arbitration, not a persistent problem.
        if (statusCode === 409) {
          logger.warn(`Session conflict (409) for ${accountId} — another instance may be active`);
          this.connectionStates.set(accountId, { status: 'reconnecting' });
          this.emit('account-status', { accountId, status: 'reconnecting', message: 'Resolving session conflict...' });
          // Wait 2 minutes before retry to let the other instance release
          this.scheduleReconnect(accountId, 120000 + Math.floor(Math.random() * 15000));
          return;
        }

        // Status 412 = Precondition Failed — session pre-keys are outdated or invalid.
        // Clear session and force re-authentication to regenerate all keys.
        if (statusCode === 412) {
          logger.warn(`Precondition failed (412) for ${accountId} — pre-keys outdated, clearing session`);
          await this.clearCorruptedSession(accountId);
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
          
          // Exponential backoff with jitter: 120s, 240s, 480s + random 0-30s
          // Doubled from original 60s base — rapid reconnection attempts are a
          // major ban signal. WhatsApp flags IPs/accounts that reconnect too often.
          const baseDelay = Math.min(120000 * Math.pow(2, attempts), 960000);
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
        const pushName = sock.user?.name || null;
        
        // Fetch profile picture in background (don't block connection)
        let profilePicUrl = null;
        try {
          const userJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
          if (userJid) {
            profilePicUrl = await sock.profilePictureUrl(userJid, 'image').catch(() => null);
          }
        } catch (e) {
          logger.debug(`Could not fetch profile picture for ${accountId}: ${e.message}`);
        }

        this.connectionStates.set(accountId, { status: 'ready', phoneNumber, pushName, profilePicUrl });
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

        // Start periodic session saves (safety net for ephemeral filesystems)
        this._startPeriodicSessionSave(accountId);

        // Post-connect delayed save: capture any Signal key syncs that
        // happen right after connection is established (history sync,
        // pre-key replenishment, app-state-sync).
        setTimeout(() => {
          if (!this.isShuttingDown && !this.deletedAccounts.has(accountId)) {
            this.saveSession(accountId).catch(e =>
              logger.debug(`Post-connect delayed save failed for ${accountId}: ${e.message}`)
            );
          }
        }, 15000);

        this.emit('account-status', { accountId, status: 'ready', phoneNumber });
        logger.info(`Account ${accountId} connected successfully (${phoneNumber})`);

        // Proactively ensure pre-keys are available on the server.
        // If pre-keys are depleted (e.g., after restore from DB or heavy traffic),
        // new contacts can't establish Signal sessions → CIPHERTEXT on first message.
        // Baileys does this in CB:success, but by the time our handler runs the
        // initial upload may have been skipped (count was OK then but got consumed).
        try {
          await sock.uploadPreKeysToServerIfRequired();
          logger.debug(`Pre-key check completed for ${accountId}`);
        } catch (e) {
          logger.warn(`Pre-key upload check failed for ${accountId}: ${e.message}`);
        }

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
        }).catch(err => logger.error(`[WEBHOOK] Connection dispatch error: ${err.message}`));
      }
      } catch (error) {
        logger.error(`Error in connection.update handler for ${accountId}: ${error.message}`);
      }
    });

    // Credentials update — write to disk immediately, debounce DB persistence.
    // creds.update fires 10+ times during key exchange / session setup.
    // The keys.set wrapper above also triggers debounced saves for Signal key
    // changes, so we don't need to force-save on every creds.update anymore.
    // Disk files are the primary source of truth; DB is only for persistence
    // across deploys/restarts.
    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        // Debounced save to DB — coalesces rapid creds.update bursts
        this._scheduleSessionSave(accountId);
      } catch (error) {
        logger.error(`Error saving creds for ${accountId}: ${error.message}`);
      }
    });

    // Incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      logger.debug(`messages.upsert event: type=${type}, count=${messages.length}`);
      webhookDeliveryService.pipelineStats.upsert_events++;

      // Store messages in cache for retry system.
      // This is critical: when WA server asks us to re-send a message for
      // decryption, getMessage() looks up the stored content.
      // For 'notify' (real-time) messages, store all. For history sync,
      // limit to avoid flooding the cache and evicting recent messages.
      const isRealtime = type === 'notify';
      let stored = 0;
      for (const msg of messages) {
        if (msg.key && msg.message) {
          if (isRealtime || stored < 500) {
            storeMessage(msg.key, msg.message);
            stored++;
          }
        }
      }

      // Only process 'notify' type for webhook dispatch (not history sync)
      if (type !== 'notify') {
        webhookDeliveryService.pipelineStats.upsert_not_notify++;
        webhookDeliveryService._logActivity({ type: 'pipeline_skip', stage: 'upsert_filter', reason: `type=${type}`, count: messages.length, accountId });
        logger.info(`[MESSAGE] Ignoring messages.upsert batch (type=${type}, count=${messages.length}) — only 'notify' triggers webhooks`);
        return;
      }

      webhookDeliveryService.pipelineStats.upsert_notify++;

      for (const msg of messages) {
        webhookDeliveryService.pipelineStats.messages_total++;

        // Log incoming (non-fromMe) messages at INFO, own messages at DEBUG
        // to avoid log spam from history sync of sent messages
        if (msg.key.fromMe) {
          webhookDeliveryService.pipelineStats.messages_from_me++;
          logger.debug(`[MESSAGE] messages.upsert: fromMe=true, remoteJid=${msg.key.remoteJid}, hasContent=${!!msg.message}`);
          continue;
        }

        logger.info(`[MESSAGE] messages.upsert: fromMe=false, remoteJid=${msg.key.remoteJid}, hasContent=${!!msg.message}, pushName=${msg.pushName || 'N/A'}`);
        webhookDeliveryService.pipelineStats.messages_to_handler++;

        // Handle message in background to not block event loop
        this.handleIncomingMessage(accountId, msg).catch(err => {
          webhookDeliveryService.pipelineStats.handler_error++;
          webhookDeliveryService._logActivity({ type: 'pipeline_error', stage: 'handler_catch', error: err.message, accountId, remoteJid: msg.key.remoteJid });
          logger.error(`Error in message handler for account ${accountId}:`, err.message);
        });
      }
    });

    // Message status updates
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.update?.status) {
          const remoteJid = update.key.remoteJid;
          const resolvedPhone = this.getPhoneNumber(remoteJid);
          // Status codes: 1=pending, 2=sent(server), 3=delivered, 4=read, 5=played
          const statusLabels = { 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'played' };
          const statusCode = update.update.status;
          webhookDeliveryService.dispatch(accountId, 'message.status', {
            messageId: update.key.id,
            status: statusCode,
            statusLabel: statusLabels[statusCode] || 'unknown',
            phone: resolvedPhone || null,
            timestamp: new Date().toISOString()
          }).catch(err => logger.error(`[WEBHOOK] Status dispatch error: ${err.message}`));
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
      // Cap at 500 to avoid flooding the cache and evicting recent messages
      // Also extract LID mappings from message keys (senderPn/senderLid)
      if (messages?.length) {
        let historyStored = 0;
        for (const msg of messages) {
          if (msg.key && msg.message && historyStored < 500) {
            storeMessage(msg.key, msg.message);
            historyStored++;
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
      webhookDeliveryService.pipelineStats.handler_started++;

      const sock = this.connections.get(accountId);
      if (!sock) {
        webhookDeliveryService.pipelineStats.handler_no_socket++;
        webhookDeliveryService._logActivity({ type: 'pipeline_skip', stage: 'handler_no_socket', accountId, remoteJid: msg.key.remoteJid });
        logger.warn(`Socket not found for account ${accountId}`);
        return;
      }

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');

      // Delayed read receipt — real users don't read every message, and their
      // read timing varies wildly (might read in 2s while focused, or 5min later).
      // Fixed 70% rate is a detectable pattern. Use variable probability per-session
      // (40-65%) and much wider delay range to mimic real behavior.
      const readProbability = 0.40 + Math.random() * 0.25; // 40-65% per message
      if (Math.random() < readProbability) {
        // Wider range: 3-45s. Most real users don't read within 3s of receive.
        // Add a long-tail: 10% chance of very delayed read (30-120s).
        let readDelay;
        if (Math.random() < 0.10) {
          readDelay = humanDelay(30000, 120000); // occasional very late read
        } else {
          readDelay = humanDelay(3000, 45000);
        }
        setTimeout(() => {
          sock.readMessages([msg.key]).catch(err => {
            logger.debug(`Could not send read receipt: ${err.message}`);
          });
        }, readDelay);
      }
      
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

        // Strategy 2: Try rate-limited onWhatsApp() API call as last resort
        if (!senderInfo.phone) {
          const result = await this._safeOnWhatsApp(accountId, lidNumber);
          if (result?.exists && result.jid && result.jid.includes('@s.whatsapp.net')) {
            const resolvedPhone = result.jid.split('@')[0];
            this.registerLidPhoneMapping(lidNumber, resolvedPhone);
            senderInfo.phone = resolvedPhone;
            logger.info(`[LID-MAP] Resolved LID ${lidNumber} → phone ${resolvedPhone} via onWhatsApp()`);
          }
        }

        if (!senderInfo.phone) {
          logger.warn(`[LID-MAP] Could not resolve phone for LID ${lidNumber} — phone will be null in webhook payload`);
        }
      }

      const senderPhone = senderInfo.phone || senderInfo.lid || null;
      const directReplyPhone = !isGroup ? (senderInfo.phone || null) : null;
      const directReplyJid = directReplyPhone ? `${directReplyPhone}@s.whatsapp.net` : null;
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
      let pollData = null;

      const message = msg.message;
      if (!message) {
        webhookDeliveryService.pipelineStats.handler_null_message++;
        // Distinguish stub notifications (group events) from decryption failures
        if (msg.messageStubType === 2) {
          webhookDeliveryService.pipelineStats.handler_ciphertext++;
          const decryptError = msg.messageStubParameters?.[0] || 'unknown';
          webhookDeliveryService._logActivity({ type: 'pipeline_skip', stage: 'handler_null_message', reason: 'CIPHERTEXT_decryption_failure', accountId, remoteJid: remoteJid, pushName: msg.pushName || 'Unknown', error: decryptError });
          // StubType 2 = CIPHERTEXT: Baileys received the message but FAILED to
          // decrypt it. The Signal session with this contact is corrupted.
          logger.warn(`[MESSAGE] CIPHERTEXT (decryption failure) from ${contactId} (pushName: ${msg.pushName || 'Unknown'}, jid: ${remoteJid}, msgId: ${msg.key.id}, error: ${decryptError}).`);

          // NOT dispatching a webhook for decryption failures — Baileys' retry
          // mechanism will recover the session and re-deliver the message.
          // Sending this to webhooks caused automation systems (e.g. n8n) to
          // echo "[Decryption failed]" text back to contacts.

          // DO NOT call assertSessions() here — Baileys has its own retry
          // mechanism (sendRetryRequest in messages-recv.js) that handles
          // decryption failures. When decryption fails, Baileys:
          //   1. Sets messageStubType = CIPHERTEXT
          //   2. Sends a retry request to the sender via retryMutex
          //   3. On retry response, re-decrypts with fresh keys
          // Calling assertSessions(jid, true) would destroy the Signal session
          // that Baileys needs for step 3, causing ALL subsequent messages to
          // fail with CIPHERTEXT. This was the root cause of the "works once
          // then fails to decrypt" issue.
          // The session will self-heal through Baileys' retry mechanism.
          logger.info(`[MESSAGE] CIPHERTEXT from ${remoteJid} — Baileys retry mechanism will handle session recovery (no manual reset)`);
        } else if (msg.messageStubType) {
          webhookDeliveryService.pipelineStats.handler_stub_notification++;
          webhookDeliveryService._logActivity({ type: 'pipeline_skip', stage: 'handler_null_message', reason: `stub_type_${msg.messageStubType}`, accountId, remoteJid: remoteJid });
          logger.info(`[MESSAGE] Notification stub from ${contactId} (stubType: ${msg.messageStubType}, pushName: ${msg.pushName || 'N/A'}) — no webhook sent.`);
        } else {
          webhookDeliveryService._logActivity({ type: 'pipeline_skip', stage: 'handler_null_message', reason: 'null_message_no_stub', accountId, remoteJid: remoteJid, pushName: msg.pushName || 'Unknown' });
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
      } else if (unwrapped.pollCreationMessage || unwrapped.pollCreationMessageV2 || unwrapped.pollCreationMessageV3) {
        const poll = unwrapped.pollCreationMessage || unwrapped.pollCreationMessageV2 || unwrapped.pollCreationMessageV3;
        messageText = poll.name || '[Poll]';
        messageType = 'poll';
        // Attach poll details for the webhook
        pollData = {
          question: poll.name || '',
          options: (poll.options || []).map(o => o.optionName || ''),
          selectableCount: poll.selectableOptionsCount || 0
        };
      } else if (unwrapped.pollUpdateMessage) {
        // Poll vote received — extract voter and referenced poll
        const pollUpdate = unwrapped.pollUpdateMessage;
        const pollMsgKey = pollUpdate.pollCreationMessageKey;
        messageType = 'poll_vote';
        messageText = '[Poll Vote]';
        pollData = {
          pollMessageId: pollMsgKey?.id || null,
          voterTimestamp: pollUpdate.senderTimestampMs
            ? Number(pollUpdate.senderTimestampMs)
            : null
        };
        // Try to decrypt the vote using the stored poll creation message
        if (pollMsgKey?.id) {
          try {
            // Use getStoredMessage (module-level function) — NOT getMessage
            // (which is only a socket config callback, not in this scope).
            const pollCreationMsg = getStoredMessage(pollMsgKey);
            if (pollCreationMsg) {
              const pollEncKey = (pollCreationMsg.messageContextInfo || pollCreationMsg.message?.messageContextInfo)?.messageSecret;
              if (pollEncKey && pollUpdate.vote?.encPayload) {
                const { decryptPollVote } = require('@whiskeysockets/baileys');
                const meId = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
                const pollCreatorJid = pollMsgKey.fromMe
                  ? meId
                  : (pollMsgKey.participant || pollMsgKey.remoteJid);
                const voterJid = msg.key.fromMe
                  ? meId
                  : (msg.key.participant || msg.key.remoteJid);
                const decrypted = decryptPollVote(
                  pollUpdate.vote,
                  {
                    pollEncKey,
                    pollCreatorJid,
                    pollMsgId: pollMsgKey.id,
                    voterJid
                  }
                );
                // decrypted.selectedOptions is array of SHA256 hashes
                // Map hashes back to option names using the poll creation message
                const pollCreation = pollCreationMsg.pollCreationMessage
                  || pollCreationMsg.pollCreationMessageV2
                  || pollCreationMsg.pollCreationMessageV3;
                if (pollCreation?.options) {
                  const { createHash } = require('crypto');
                  const hashToName = {};
                  for (const opt of pollCreation.options) {
                    const hash = createHash('sha256').update(Buffer.from(opt.optionName || '')).digest().toString();
                    hashToName[hash] = opt.optionName;
                  }
                  pollData.selectedOptions = (decrypted.selectedOptions || []).map(h => {
                    const hashStr = Buffer.from(h).toString();
                    return hashToName[hashStr] || hashStr;
                  });
                  pollData.pollQuestion = pollCreation.name || null;
                }
              }
            }
          } catch (pollDecryptErr) {
            logger.warn(`[MESSAGE] Failed to decrypt poll vote: ${pollDecryptErr.message}`);
          }
        }
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
        webhookDeliveryService.pipelineStats.handler_protocol_msg++;
        webhookDeliveryService._logActivity({ type: 'pipeline_skip', stage: 'handler_protocol_msg', protocolType: unwrapped.protocolMessage.type, accountId });
        logger.info(`[MESSAGE] Protocol message from ${contactId} (type: ${unwrapped.protocolMessage.type || 'unknown'}), skipping webhook`);
        return;
      } else {
        const msgTypes = Object.keys(unwrapped);
        logger.info(`[MESSAGE] Unhandled message type from ${contactId}: ${msgTypes.join(', ')}`);
        messageText = `[${msgTypes[0] || 'Unknown'}]`;
        messageType = 'unknown';
      }

      if (!messageText && messageType === 'text') {
        webhookDeliveryService.pipelineStats.handler_empty_text++;
        webhookDeliveryService._logActivity({ type: 'pipeline_skip', stage: 'handler_empty_text', accountId, remoteJid: remoteJid });
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
        phone: senderInfo.phone || null,
        message: messageText,
        messageType,
        isGroup,
        timestamp: msg.messageTimestamp,
        pushName: msg.pushName || 'Unknown',
        replyTo: isGroup ? remoteJid : directReplyPhone,
      };

      // Include LID only when available (useful for LID-based systems)
      if (senderInfo.lid) {
        webhookPayload.lid = senderInfo.lid;
      }

      // Add group info for automations that need participant context.
      if (isGroup) {
        webhookPayload.groupJid = remoteJid;
        webhookPayload.participant = msg.key.participant || null;
        // Use participantPn from message key first (most reliable), then fallback to mapping
        const participantPnJid = msg.key.participantPn;
        const participantPnPhone = participantPnJid ? participantPnJid.split('@')[0] : null;
        webhookPayload.participantPhone = participantPnPhone || (msg.key.participant ? this.getPhoneNumber(msg.key.participant) : null);
      }

      // Add poll data when available
      if (pollData) {
        webhookPayload.poll = pollData;
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
      webhookDeliveryService.pipelineStats.handler_dispatch_reached++;
      webhookDeliveryService.messageHandlerCalls++;
      webhookDeliveryService._logActivity({ type: 'message_received', accountId, messageType, from: senderInfo.phone || senderInfo.lid || 'unknown', pushName: msg.pushName || 'Unknown' });
      
      try {
        await webhookDeliveryService.dispatch(accountId, 'message', webhookPayload);
        logger.info(`[MESSAGE] Webhook dispatch completed for account ${accountId}`);
      } catch (webhookErr) {
        logger.error(`[MESSAGE] Webhook dispatch error: ${webhookErr.message}`);
        webhookDeliveryService._logActivity({ type: 'dispatch_error', accountId, error: webhookErr.message });
      }

      // AI Auto-reply (only for text messages, non-group)
      // Incoming human message resets the AI reply counter for this contact
      // (only count consecutive AI replies as a loop)
      if (contactId) this._resetAiReplyCounter(accountId, contactId);

      if (messageType === 'text' && !isGroup && contactId) {
        if (!directReplyJid) {
          logger.info(`[AI] Skipping auto-reply to ${contactId} for ${accountId} — no safe phone reply target resolved yet`);
          return;
        }

        // Loop guard: block if we've already sent MAX consecutive AI replies
        if (!this._checkAiReplyAllowed(accountId, contactId)) {
          logger.info(`[AI] Skipping auto-reply to ${contactId} for ${accountId} — loop guard active`);
        } else {
          // Add human-like delay before AI responds
          const aiDelay = humanDelay(2000, 6000);
          setTimeout(() => {
            aiAutoReply.generateReply({
              accountId,
              contactId,
              message: messageText
            }).then(aiReply => {
              if (aiReply) {
                this.sendMessageToJid(accountId, directReplyJid, aiReply).catch(err => {
                  logger.error(`Failed to send AI reply: ${err.message}`);
                });
              }
            }).catch(err => {
              logger.error(`AI reply generation failed: ${err.message}`);
            });
          }, aiDelay);
        }
      }
    } catch (error) {
      webhookDeliveryService.pipelineStats.handler_error++;
      webhookDeliveryService._logActivity({ type: 'pipeline_error', stage: 'handler_exception', error: error.message, accountId, stack: error.stack?.split('\n').slice(0, 3).join(' | ') });
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

    // Rate limit check — prevents burst sending that WhatsApp flags
    if (!this._checkSendRateLimit(accountId)) {
      throw new Error('Rate limit exceeded — max 20 messages per minute. Please slow down.');
    }

    // Check for duplicate
    if (this.isDuplicateMessage(accountId, jid, message)) {
      logger.warn(`Duplicate message blocked for ${phone}`);
      throw new Error('Duplicate message detected');
    }

    // Serialize sends per account — prevents concurrent API calls from fighting
    // over the same presence state, which looks like bulk messaging to WA servers.
    return this._enqueueSend(accountId, async () => {
      // Enforce minimum inter-message gap inside the queue. Back-to-back sends
      // without a floor look machine-generated even with typing delays.
      const lastSend = this.lastSendTimestamp.get(accountId) || 0;
      const sinceLastSend = Date.now() - lastSend;
      if (sinceLastSend < this.MIN_SEND_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, this.MIN_SEND_INTERVAL_MS - sinceLastSend));
      }
      this.lastSendTimestamp.set(accountId, Date.now());

      const jidKey = `${accountId}:${jid}`;
      const lastConvoTime = this.lastMessagePerJid.get(jidKey) || 0;
      const isActiveConvo = (Date.now() - lastConvoTime) < this.ACTIVE_CONVO_WINDOW_MS;

      try {
        // Only broadcast global 'available' on cold-start (opening a chat for the first
        // time). Toggling available→unavailable around every single message is a mechanical
        // bot fingerprint — real users stay "available" throughout a conversation.
        if (!isActiveConvo) {
          await sock.sendPresenceUpdate('available').catch(() => {});
          await new Promise(resolve => setTimeout(resolve, humanDelay(300, 800)));
        }

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
        db.addConversationMessage(accountId, contactId, 'outgoing', message, 'text').catch(dbErr => {
          logger.error(`[MESSAGE] Failed to save outgoing conversation for ${accountId}/${contactId}: ${dbErr.message}`);
        });

        // Schedule debounced session save — Signal pre-keys update on sends but
        // saving to DB on every single message causes write storms and DB contention.
        // Disk files are always up-to-date; debounce ensures at most one DB write per 30s.
        this._scheduleSessionSave(accountId);

        // Mark this JID as "active conversation" so the next message skips 'available'.
        this.lastMessagePerJid.set(jidKey, Date.now());

        // Go unavailable only after the conversation goes quiet — real users stay visible
        // for 15-40s after a message, not 2-8s. Only fire if no new message was sent to
        // this JID in the meantime (avoids rapid off/on flicker during a conversation).
        const unavailableDelay = humanDelay(15000, 40000);
        setTimeout(() => {
          const timeSinceLastMsg = Date.now() - (this.lastMessagePerJid.get(jidKey) || 0);
          if (timeSinceLastMsg > 10000) {
            sock.sendPresenceUpdate('unavailable').catch(() => {});
          }
        }, unavailableDelay);

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
    });
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

    // Rate limit check
    if (!this._checkSendRateLimit(accountId)) {
      throw new Error('Rate limit exceeded — max 20 messages per minute. Please slow down.');
    }

    // Check for duplicate
    if (this.isDuplicateMessage(accountId, resolvedJid, message)) {
      logger.warn(`Duplicate message blocked for ${jid}`);
      throw new Error('Duplicate message detected');
    }

    // Serialize sends per account — prevents concurrent presence-state race.
    return this._enqueueSend(accountId, async () => {
      // Enforce minimum inter-message gap inside the queue.
      const lastSend = this.lastSendTimestamp.get(accountId) || 0;
      const sinceLastSend = Date.now() - lastSend;
      if (sinceLastSend < this.MIN_SEND_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, this.MIN_SEND_INTERVAL_MS - sinceLastSend));
      }
      this.lastSendTimestamp.set(accountId, Date.now());

      const jidKey = `${accountId}:${resolvedJid}`;
      const lastConvoTime = this.lastMessagePerJid.get(jidKey) || 0;
      const isActiveConvo = (Date.now() - lastConvoTime) < this.ACTIVE_CONVO_WINDOW_MS;

      try {
        // Only send global 'available' on cold-start.
        if (!isActiveConvo) {
          await sock.sendPresenceUpdate('available').catch(() => {});
          await new Promise(resolve => setTimeout(resolve, humanDelay(300, 800)));
        }

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
        db.addConversationMessage(accountId, contactId, 'outgoing', message, 'text').catch(dbErr => {
          logger.error(`[MESSAGE] Failed to save outgoing conversation for ${accountId}/${contactId}: ${dbErr.message}`);
        });

        // Schedule debounced session save (at most once per 30s, not on every send)
        this._scheduleSessionSave(accountId);

        // Mark this JID as active conversation.
        this.lastMessagePerJid.set(jidKey, Date.now());

        // Go unavailable only after the conversation goes quiet.
        const unavailableDelay = humanDelay(15000, 40000);
        setTimeout(() => {
          const timeSinceLastMsg = Date.now() - (this.lastMessagePerJid.get(jidKey) || 0);
          if (timeSinceLastMsg > 10000) {
            sock.sendPresenceUpdate('unavailable').catch(() => {});
          }
        }, unavailableDelay);

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
    });
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

    // Rate limit check
    if (!this._checkSendRateLimit(accountId)) {
      throw new Error('Rate limit exceeded — max 20 messages per minute. Please slow down.');
    }

    // Serialize sends per account — prevents concurrent presence-state race.
    return this._enqueueSend(accountId, async () => {
      // Enforce minimum inter-message gap inside the queue.
      const lastSend = this.lastSendTimestamp.get(accountId) || 0;
      const sinceLastSend = Date.now() - lastSend;
      if (sinceLastSend < this.MIN_SEND_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, this.MIN_SEND_INTERVAL_MS - sinceLastSend));
      }
      this.lastSendTimestamp.set(accountId, Date.now());

      const jidKey = `${accountId}:${jid}`;
      const lastConvoTime = this.lastMessagePerJid.get(jidKey) || 0;
      const isActiveConvo = (Date.now() - lastConvoTime) < this.ACTIVE_CONVO_WINDOW_MS;

      try {
        // Only send global 'available' on cold-start.
        if (!isActiveConvo) {
          await sock.sendPresenceUpdate('available').catch(() => {});
          await new Promise(resolve => setTimeout(resolve, humanDelay(500, 1500)));
        }
        
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

        // Schedule debounced session save (at most once per 30s, not on every send)
        this._scheduleSessionSave(accountId);

        // Mark this JID as active conversation.
        this.lastMessagePerJid.set(jidKey, Date.now());

        // Go unavailable only after the conversation goes quiet.
        const unavailableDelay = humanDelay(15000, 40000);
        setTimeout(() => {
          const timeSinceLastMsg = Date.now() - (this.lastMessagePerJid.get(jidKey) || 0);
          if (timeSinceLastMsg > 10000) {
            sock.sendPresenceUpdate('unavailable').catch(() => {});
          }
        }, unavailableDelay);

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
    });
  }

  /**
   * Send a poll message
   * @param {string} phoneOrJid - Phone number, LID, or full JID
   * @param {string} name - Poll question
   * @param {string[]} values - Array of poll options (2-12)
   * @param {number} selectableCount - How many options can be selected (0 = unlimited)
   */
  async sendPoll(accountId, phoneOrJid, name, values, selectableCount = 0) {
    const sock = this.connections.get(accountId);
    if (!sock) {
      throw new Error('Account not connected');
    }

    const jid = await this.resolveRecipientJid(accountId, phoneOrJid);

    // Rate limit check
    if (!this._checkSendRateLimit(accountId)) {
      throw new Error('Rate limit exceeded — max 20 messages per minute. Please slow down.');
    }

    // Serialize sends per account — prevents concurrent presence-state race.
    return this._enqueueSend(accountId, async () => {
      // Enforce minimum inter-message gap inside the queue.
      const lastSend = this.lastSendTimestamp.get(accountId) || 0;
      const sinceLastSend = Date.now() - lastSend;
      if (sinceLastSend < this.MIN_SEND_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, this.MIN_SEND_INTERVAL_MS - sinceLastSend));
      }
      this.lastSendTimestamp.set(accountId, Date.now());

      const jidKey = `${accountId}:${jid}`;
      const lastConvoTime = this.lastMessagePerJid.get(jidKey) || 0;
      const isActiveConvo = (Date.now() - lastConvoTime) < this.ACTIVE_CONVO_WINDOW_MS;

      try {
        if (!isActiveConvo) {
          await sock.sendPresenceUpdate('available').catch(() => {});
          await new Promise(resolve => setTimeout(resolve, humanDelay(500, 1500)));
        }
        await sock.sendPresenceUpdate('composing', jid).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, humanDelay(1000, 2500)));
        await sock.sendPresenceUpdate('paused', jid).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, humanDelay(200, 500)));

        const result = await sock.sendMessage(jid, {
          poll: {
            name,
            values,
            selectableCount: selectableCount || 0
          }
        });

        if (result?.key && result?.message) storeMessage(result.key, result.message);

        this.metrics.messagesSent++;
        logger.info(`Poll sent to ${phoneOrJid} from account ${accountId}`);
        this._scheduleSessionSave(accountId);

        this.lastMessagePerJid.set(jidKey, Date.now());
        const unavailableDelay = humanDelay(15000, 40000);
        setTimeout(() => {
          const timeSinceLastMsg = Date.now() - (this.lastMessagePerJid.get(jidKey) || 0);
          if (timeSinceLastMsg > 10000) {
            sock.sendPresenceUpdate('unavailable').catch(() => {});
          }
        }, unavailableDelay);

        return {
          success: true,
          messageId: result.key.id,
          to: jid,
          phone: this.getPhoneNumber(jid) || phoneOrJid,
          timestamp: Date.now()
        };
      } catch (error) {
        logger.error(`Failed to send poll to ${phoneOrJid}:`, error.message);
        throw error;
      }
    });
  }

  /**
   * Disconnect account
   */
  async disconnect(accountId, updateDb = true) {
    // Stop periodic session saves
    this._stopPeriodicSessionSave(accountId);

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
                // Validate ALL critical Signal protocol keys.
                // Missing any of these means the session can't complete a
                // valid handshake, causing auth failures or Bad MAC errors
                // that trigger rapid reconnection cycles → ban risk.
                credsValid = !!(parsed.noiseKey && parsed.signedIdentityKey && parsed.signedPreKey && parsed.registrationId);
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

      // Hash-based change detection: skip DB write if session is unchanged
      const hash = crypto.createHash('sha256').update(encoded).digest('hex');
      const lastHash = this.lastSessionHashes.get(accountId);
      if (hash === lastHash) {
        logger.debug(`Session unchanged for account ${accountId}, skipping DB write`);
        return;
      }
      
      await db.updateAccount(accountId, { 
        session_data: encoded,
        last_session_saved: new Date().toISOString()
      });

      this.lastSessionHashes.set(accountId, hash);
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
   * Schedule a debounced session save to DB.
   * Coalesces rapid save requests (e.g. from creds.update bursts during
   * key exchange) into a single DB write, preventing write storms.
   * The session is always up-to-date on disk (via saveCreds); this only
   * affects DB persistence for cross-deploy/restart recovery.
   */
  _scheduleSessionSave(accountId) {
    if (this.isShuttingDown || this.deletedAccounts.has(accountId)) return;

    // Clear existing timer for this account (resets the debounce window)
    const existing = this.sessionSaveTimers.get(accountId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.sessionSaveTimers.delete(accountId);
      this.saveSession(accountId).catch(e =>
        logger.debug(`Debounced session save failed for ${accountId}: ${e.message}`)
      );
    }, this.SESSION_SAVE_DEBOUNCE_MS);

    this.sessionSaveTimers.set(accountId, timer);
  }

  /**
   * Start periodic session save timer for an account.
   * Acts as a safety net to ensure session state reaches the DB even if
   * individual debounced saves are missed due to race conditions.
   */
  _startPeriodicSessionSave(accountId) {
    this._stopPeriodicSessionSave(accountId);
    const timer = setInterval(() => {
      if (this.isShuttingDown || this.deletedAccounts.has(accountId)) {
        this._stopPeriodicSessionSave(accountId);
        return;
      }
      this.saveSession(accountId).catch(e =>
        logger.debug(`Periodic session save failed for ${accountId}: ${e.message}`)
      );
    }, this.PERIODIC_SESSION_SAVE_MS);
    // Allow Node to exit even if the timer is still running
    timer.unref();
    this.periodicSessionSaveTimers.set(accountId, timer);
    logger.debug(`Started periodic session save for ${accountId} every ${this.PERIODIC_SESSION_SAVE_MS / 1000}s`);
  }

  /**
   * Stop periodic session save timer for an account.
   */
  _stopPeriodicSessionSave(accountId) {
    const timer = this.periodicSessionSaveTimers.get(accountId);
    if (timer) {
      clearInterval(timer);
      this.periodicSessionSaveTimers.delete(accountId);
    }
  }

  /**
   * Flush all pending debounced session saves immediately.
   * Called during graceful shutdown to ensure no session data is lost.
   */
  async _flushPendingSessionSaves() {
    const accountIds = Array.from(this.sessionSaveTimers.keys());
    for (const [, timer] of this.sessionSaveTimers) {
      clearTimeout(timer);
    }
    this.sessionSaveTimers.clear();

    for (const accountId of accountIds) {
      try {
        await this.saveSession(accountId);
        logger.debug(`Flushed pending session save for ${accountId}`);
      } catch (e) {
        logger.warn(`Failed to flush session save for ${accountId}: ${e.message}`);
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

      // Seed the hash map so the first saveSession() after restore correctly
      // detects whether keys have actually changed during initial sync.
      const restoreHash = crypto.createHash('sha256').update(sessionData).digest('hex');
      this.lastSessionHashes.set(accountId, restoreHash);

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

          // Validate ALL critical identity keys — missing ANY of these means
          // the session can't establish a valid Signal encryption channel.
          // Restoring an incomplete session causes auth failures (401/440)
          // which trigger rapid reconnect cycles that WhatsApp detects as
          // suspicious activity, leading to account bans.
          if (!creds.signedIdentityKey || !creds.noiseKey || !creds.signedPreKey || !creds.registrationId) {
            logger.warn(`Session for ${accountId} missing critical identity keys (signedIdentityKey: ${!!creds.signedIdentityKey}, noiseKey: ${!!creds.noiseKey}, signedPreKey: ${!!creds.signedPreKey}, registrationId: ${!!creds.registrationId}), discarding`);
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

    // Stop memory cleanup
    if (this._memoryCleanupInterval) {
      clearInterval(this._memoryCleanupInterval);
      this._memoryCleanupInterval = null;
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

    // Stop all periodic session save timers
    for (const [accountId, timer] of this.periodicSessionSaveTimers) {
      clearInterval(timer);
    }
    this.periodicSessionSaveTimers.clear();

    // Persist LID mappings one last time
    await this._persistLidMappings();

    // Persist message store for retry survival across restarts
    stopMessageStorePersistence();
    await saveMessageStoreToDisk();

    // Flush any pending debounced session saves to DB before disconnecting
    await this._flushPendingSessionSaves();
    
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
    this.sessionSaveTimers.clear();
    
    logger.info('WhatsApp manager shutdown complete');
  }
}

// Export singleton instance
module.exports = new WhatsAppManager();
