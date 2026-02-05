/**
 * WhatsApp Manager - Baileys Version
 * Core module for managing WhatsApp connections using @whiskeysockets/baileys
 * No browser/Chromium required - uses WebSocket protocol
 */

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidDecode } = require('@whiskeysockets/baileys');
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
// CONFIGURATION
// ============================================================================

const AUTH_STATES_DIR = path.join(__dirname, '..', 'auth_states');

// Message retry counter cache
const msgRetryCounterCache = new NodeCache({ stdTTL: 600, checkperiod: 60 });

// Duplicate message prevention
const recentMessageHashes = new Map();
const DUPLICATE_WINDOW_MS = 60000;

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
   * Get phone number from JID
   */
  getPhoneNumber(jid) {
    if (!jid) return null;
    
    // Handle LID format (e.g., "110789050532030@lid")
    if (jid.includes('@lid')) {
      // LID format - return as-is since we can't convert without mapping
      return jid.split('@')[0];
    }
    
    const decoded = jidDecode(jid);
    return decoded?.user || jid.split('@')[0];
  }

  /**
   * Try to get real phone number from message
   * Handles both regular JIDs and LID format
   */
  extractSenderPhone(msg, sock) {
    const remoteJid = msg.key.remoteJid;
    
    // For group messages, participant contains the actual sender
    if (msg.key.participant) {
      return this.getPhoneNumber(msg.key.participant);
    }
    
    // Check if it's a LID (Linked ID) format
    if (remoteJid?.includes('@lid')) {
      // Try to get from verifiedBizName or pushName context
      // The LID can be used to reply, but we should try to get real number
      
      // Check device list cache for mapping
      const lidNumber = remoteJid.split('@')[0];
      
      // Try to find phone number from sock store
      if (sock?.store?.contacts) {
        const contact = sock.store.contacts[remoteJid];
        if (contact?.id && !contact.id.includes('@lid')) {
          return this.getPhoneNumber(contact.id);
        }
      }
      
      // Return LID with a prefix indicator so user knows it's not a phone
      return lidNumber;
    }
    
    return this.getPhoneNumber(remoteJid);
  }

  /**
   * Format phone number to JID
   */
  formatJid(phone) {
    const cleaned = phone.replace(/[^0-9]/g, '');
    return `${cleaned}@s.whatsapp.net`;
  }

  /**
   * Check for duplicate message
   */
  isDuplicateMessage(accountId, jid, message) {
    const msgHash = crypto.createHash('sha256').update(message).digest('hex').slice(0, 16);
    const key = `${accountId}:${jid}:${msgHash}`;
    
    const lastSent = recentMessageHashes.get(key);
    if (lastSent && (Date.now() - lastSent) < DUPLICATE_WINDOW_MS) {
      return true;
    }

    recentMessageHashes.set(key, Date.now());
    
    // Cleanup old entries
    if (recentMessageHashes.size > 10000) {
      const oldest = recentMessageHashes.keys().next().value;
      recentMessageHashes.delete(oldest);
    }

    return false;
  }

  /**
   * Initialize all accounts from database
   */
  async initializeAccounts() {
    try {
      const accounts = await db.getAccounts();
      logger.info(`Found ${accounts.length} accounts to initialize`);

      for (const account of accounts) {
        if (account.status === 'ready' || account.session_data) {
          await this.connect(account.id);
        }
      }
    } catch (error) {
      logger.error('Failed to initialize accounts:', error.message);
    }
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

      // Double-check with a small delay to catch race conditions
      this.connectionLocks.add(accountId);
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Check if this is a new account (no existing session data)
      const accountCheck = await db.getAccountById(accountId);
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

      // Set connection lock
      this.connectionLocks.add(accountId);
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
      if (account.session_data) {
        await this.restoreSession(accountId, account.session_data, authPath);
      }

      const { state, saveCreds } = await useMultiFileAuthState(authPath);

      // Get latest Baileys version
      const { version } = await fetchLatestBaileysVersion();

      // Create silent logger for Baileys
      const baileysLogger = pino({ level: 'silent' });

      // Create socket with anti-ban settings
      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: ['WhatsApp Multi-Automation', 'Chrome', '120.0.0'],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false, // Don't mark online immediately - more natural
        getMessage: async (key) => {
          return { conversation: '' };
        },
        msgRetryCounterCache,
        // Anti-ban: Disable link previews and aggressive features
        linkPreviewImageThumbnailWidth: 0
      });

      // Store connection
      this.connections.set(accountId, sock);

      // Setup event handlers
      this.setupEventHandlers(accountId, sock, saveCreds);

      // Release lock after short delay (handlers take over)
      // Use shorter delay - 30s is enough for QR generation
      const lockReleaseDelay = isNewAccount ? 30000 : 5000;
      setTimeout(() => this.connectionLocks.delete(accountId), lockReleaseDelay);

      // Setup watchdog timer for new accounts waiting for QR scan
      // If no QR generated or no connection within 60s, mark as error
      if (isNewAccount) {
        this.setupConnectionWatchdog(accountId);
      }

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

    // Connection update
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

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

        // Status 408 = QR timeout - don't auto-reconnect, wait for user action
        if (statusCode === 408) {
          logger.info(`QR timeout for ${accountId}, waiting for user to reconnect`);
          this.connectionStates.set(accountId, { status: 'disconnected', error: 'QR code expired' });
          await db.updateAccount(accountId, { 
            status: 'disconnected', 
            qr_code: null,
            error_message: 'QR code expired. Click Reconnect to try again.'
          }).catch(e => logger.warn(`Failed to update account status: ${e.message}`));
          this.emit('account-status', { accountId, status: 'disconnected', message: 'QR expired - click Reconnect' });
          return;
        }

        // Status 401 = Connection failure - check if this is a new account or authenticated one
        if (statusCode === 401) {
          const account = await db.getAccountById(accountId).catch(() => null);
          const hadSession = account?.session_data != null;
          
          if (hadSession) {
            // Had a session but now invalid - clear it
            logger.info(`Account ${accountId} session invalid, clearing session`);
            this.connectionStates.set(accountId, { status: 'disconnected' });
            await db.updateAccount(accountId, { 
              status: 'disconnected', 
              session_data: null,
              qr_code: null 
            }).catch(e => logger.warn(`Failed to update account status: ${e.message}`));
            this.emit('account-status', { accountId, status: 'disconnected', message: 'Session expired - click Reconnect' });
          } else {
            // New account never authenticated - just mark as disconnected, don't spam reconnects
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

        if (statusCode === DisconnectReason.loggedOut) {
          // User logged out - clear session completely
          logger.info(`Account ${accountId} logged out, clearing session`);
          this.connectionStates.set(accountId, { status: 'disconnected' });
          await db.updateAccount(accountId, { 
            status: 'disconnected', 
            session_data: null,
            qr_code: null 
          }).catch(e => logger.warn(`Failed to update account status: ${e.message}`));
          
          this.emit('account-status', { accountId, status: 'disconnected' });
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
      await saveCreds();
      await this.saveSession(accountId);
    });

    // Incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      logger.debug(`messages.upsert event: type=${type}, count=${messages.length}`);
      
      // Handle both 'notify' (new messages) and 'append' (history sync)
      if (type !== 'notify') {
        logger.debug(`Ignoring messages.upsert with type: ${type}`);
        return;
      }

      for (const msg of messages) {
        logger.debug(`Processing message: fromMe=${msg.key.fromMe}, remoteJid=${msg.key.remoteJid}`);
        
        if (msg.key.fromMe) {
          logger.debug('Skipping own message');
          continue;
        }

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
          webhookDeliveryService.dispatch(accountId, 'message.status', {
            messageId: update.key.id,
            status: update.update.status,
            remoteJid: update.key.remoteJid
          });
        }
      }
    });
  }

  /**
   * Handle incoming message
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

      // Send read receipt in background (don't wait)
      sock.readMessages([msg.key]).catch(err => {
        logger.debug(`Could not send read receipt: ${err.message}`);
      });
      
      // Check if sender is using LID format (privacy protected)
      const isLidFormat = remoteJid?.includes('@lid');
      
      // Extract sender phone number (handles LID format too)
      const senderPhone = this.extractSenderPhone(msg, sock);
      
      // Get the raw JID for replying (may be LID or phone-based)
      const replyJid = remoteJid;
      const contactId = senderPhone;
      
      // Extract message content
      let messageText = '';
      let messageType = 'text';

      if (msg.message?.conversation) {
        messageText = msg.message.conversation;
      } else if (msg.message?.extendedTextMessage?.text) {
        messageText = msg.message.extendedTextMessage.text;
      } else if (msg.message?.imageMessage) {
        messageText = msg.message.imageMessage.caption || '[Image]';
        messageType = 'image';
      } else if (msg.message?.documentMessage) {
        messageText = msg.message.documentMessage.fileName || '[Document]';
        messageType = 'document';
      } else if (msg.message?.audioMessage) {
        messageText = '[Audio]';
        messageType = 'audio';
      } else if (msg.message?.videoMessage) {
        messageText = msg.message.videoMessage.caption || '[Video]';
        messageType = 'video';
      } else if (msg.message?.stickerMessage) {
        messageText = '[Sticker]';
        messageType = 'sticker';
      } else if (msg.message?.contactMessage) {
        messageText = msg.message.contactMessage.displayName || '[Contact]';
        messageType = 'contact';
      } else if (msg.message?.locationMessage) {
        messageText = '[Location]';
        messageType = 'location';
      } else if (msg.message?.reactionMessage) {
        messageText = msg.message.reactionMessage.text || '[Reaction]';
        messageType = 'reaction';
      } else {
        // Log unknown message types for debugging
        const msgTypes = Object.keys(msg.message || {});
        logger.debug(`Unknown message type from ${contactId}: ${msgTypes.join(', ')}`);
        messageText = `[${msgTypes[0] || 'Unknown'}]`;
        messageType = 'unknown';
      }

      // Skip if still no message content and not a known type
      if (!messageText && messageType === 'text') {
        logger.debug(`No message content for ${contactId}, skipping webhook`);
        return;
      }

      // Ensure we have some text for the webhook
      if (!messageText) {
        messageText = `[${messageType}]`;
      }

      logger.info(`[MESSAGE] Received from ${contactId}: ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);

      // Save to conversation history in background (don't block webhook)
      db.addConversationMessage(accountId, contactId, 'incoming', messageText, messageType).catch(dbErr => {
        logger.error(`[MESSAGE] Failed to save conversation: ${dbErr.message}`);
      });

      // Dispatch webhook - this is where messages get forwarded to your webhook URL
      logger.info(`[MESSAGE] Dispatching to webhooks for account ${accountId}...`);
      
      try {
        await webhookDeliveryService.dispatch(accountId, 'message', {
          messageId: msg.key.id,
          from: contactId,
          fromJid: remoteJid,
          isLidSender: isLidFormat,
          message: messageText,
          messageType,
          isGroup,
          timestamp: msg.messageTimestamp,
          pushName: msg.pushName || 'Unknown'
        });
        logger.info(`[MESSAGE] Webhook dispatch completed for account ${accountId}`);
      } catch (webhookErr) {
        logger.error(`[MESSAGE] Webhook dispatch error: ${webhookErr.message}`);
      }

      // AI Auto-reply (only for text messages, non-group)
      if (messageType === 'text' && !isGroup) {
        aiAutoReply.generateReply({
          accountId,
          contactId,
          message: messageText
        }).then(aiReply => {
          if (aiReply) {
            // Send reply in background
            this.sendMessageToJid(accountId, replyJid, aiReply).catch(err => {
              logger.error(`Failed to send AI reply: ${err.message}`);
            });
          }
        }).catch(err => {
          logger.error(`AI reply generation failed: ${err.message}`);
        });
      }
    } catch (error) {
      logger.error(`Error handling message for account ${accountId}: ${error.message}`);
    }
  }

  /**
   * Send text message
   */
  async sendMessage(accountId, phone, message) {
    const sock = this.connections.get(accountId);
    if (!sock) {
      throw new Error('Account not connected');
    }

    const jid = this.formatJid(phone);

    // Check for duplicate
    if (this.isDuplicateMessage(accountId, jid, message)) {
      logger.warn(`Duplicate message blocked for ${phone}`);
      throw new Error('Duplicate message detected');
    }

    try {
      // Simulate typing before sending (makes it look natural)
      await sock.sendPresenceUpdate('composing', jid);
      // Brief delay to show typing indicator (300-800ms based on message length)
      const typingDelay = Math.min(300 + message.length * 10, 800);
      await new Promise(resolve => setTimeout(resolve, typingDelay));
      await sock.sendPresenceUpdate('paused', jid);

      // Send message
      const result = await sock.sendMessage(jid, { text: message });

      this.metrics.messagesSent++;
      
      // Save to conversation history
      await db.addConversationMessage(accountId, phone, 'outgoing', message, 'text');

      logger.info(`Message sent to ${phone}`);

      return {
        success: true,
        messageId: result.key.id,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error(`Failed to send message to ${phone}:`, error.message);
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

    // Check for duplicate
    if (this.isDuplicateMessage(accountId, jid, message)) {
      logger.warn(`Duplicate message blocked for ${jid}`);
      throw new Error('Duplicate message detected');
    }

    try {
      // Simulate typing before sending (makes it look natural)
      await sock.sendPresenceUpdate('composing', jid);
      // Brief delay to show typing indicator (300-800ms based on message length)
      const typingDelay = Math.min(300 + message.length * 10, 800);
      await new Promise(resolve => setTimeout(resolve, typingDelay));
      await sock.sendPresenceUpdate('paused', jid);

      // Send message
      const result = await sock.sendMessage(jid, { text: message });

      this.metrics.messagesSent++;
      
      // Save to conversation history
      const contactId = this.getPhoneNumber(jid);
      await db.addConversationMessage(accountId, contactId, 'outgoing', message, 'text');

      logger.info(`Message sent to ${jid}`);

      return {
        success: true,
        messageId: result.key.id,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error(`Failed to send message to ${jid}:`, error.message);
      throw error;
    }
  }

  /**
   * Send message with auto-detection of phone number vs JID
   * @param {string} to - Phone number (e.g. "918005780278") or JID (e.g. "110789050532030@lid")
   */
  async sendMessageAuto(accountId, to, message) {
    // Auto-detect: if it contains '@' it's a JID, otherwise it's a phone number
    if (to.includes('@')) {
      return this.sendMessageToJid(accountId, to, message);
    } else {
      return this.sendMessage(accountId, to, message);
    }
  }

  /**
   * Send media message
   * @param {string} phoneOrJid - Phone number or full JID (including LID format)
   */
  async sendMedia(accountId, phoneOrJid, mediaBuffer, mediaType, caption = '', mimetype = '', filename = '') {
    const sock = this.connections.get(accountId);
    if (!sock) {
      throw new Error('Account not connected');
    }

    // Check if it's already a JID or a phone number
    let jid;
    if (phoneOrJid.includes('@')) {
      jid = phoneOrJid; // Already a JID
    } else {
      jid = this.formatJid(phoneOrJid); // Convert phone to JID
    }

    try {
      // Simulate typing before sending media (makes it look natural)
      await sock.sendPresenceUpdate('composing', jid);
      await new Promise(resolve => setTimeout(resolve, 500));
      await sock.sendPresenceUpdate('paused', jid);

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

      this.metrics.messagesSent++;
      logger.info(`Media sent to ${phoneOrJid} from account ${accountId}`);

      return {
        success: true,
        messageId: result.key.id,
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
   * Save session to database
   */
  async saveSession(accountId) {
    try {
      // Check if account still exists
      if (this.deletedAccounts.has(accountId)) {
        logger.debug(`Skipping session save for deleted account ${accountId}`);
        return;
      }

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
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const content = await fs.readFile(path.join(authPath, file), 'utf8');
            // Validate it's valid JSON
            JSON.parse(content);
            sessionData[file] = content;
          } catch (readError) {
            logger.warn(`Failed to read/parse session file ${file}: ${readError.message}`);
          }
        }
      }

      if (Object.keys(sessionData).length === 0) {
        logger.debug(`No valid session files to save for account ${accountId}`);
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
