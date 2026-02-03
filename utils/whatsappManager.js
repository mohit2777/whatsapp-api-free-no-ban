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
    this.maxReconnectAttempts = 5;
    this.maxSessionConflicts = 3; // Max 440 errors before requiring manual reconnect
    this.minReconnectInterval = 30000; // Minimum 30 seconds between any reconnection
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
    // Cancel any existing reconnect timer
    const existingTimer = this.reconnectTimers.get(accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(accountId);
      if (!this.deletedAccounts.has(accountId)) {
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

      // Start connection
      await this.connect(account.id);

      return account;
    } catch (error) {
      logger.error('Failed to create account:', error.message);
      throw error;
    }
  }

  /**
   * Delete WhatsApp account
   */
  async deleteAccount(accountId) {
    try {
      // Mark as deleted to prevent reconnection attempts
      this.deletedAccounts.add(accountId);

      // Clear any pending reconnection timer
      const timer = this.reconnectTimers.get(accountId);
      if (timer) {
        clearTimeout(timer);
        this.reconnectTimers.delete(accountId);
      }

      // Clear all tracking for this account
      this.reconnectAttempts.delete(accountId);
      this.sessionConflictCounts.delete(accountId);
      this.connectionLocks.delete(accountId);
      this.lastConnectionAttempt.delete(accountId);

      // Disconnect if connected
      await this.disconnect(accountId, false);

      // Delete from database
      await db.deleteAccount(accountId);

      // Clean up auth state files
      const authPath = path.join(AUTH_STATES_DIR, `session_${accountId}`);
      try {
        await fs.rm(authPath, { recursive: true, force: true });
      } catch (e) {
        // Ignore if doesn't exist
      }

      logger.info(`Account deleted: ${accountId}`);
      this.emit('account-deleted', { accountId });

      // Remove from deleted set after a delay (prevent race conditions)
      setTimeout(() => this.deletedAccounts.delete(accountId), 60000);

      return true;
    } catch (error) {
      logger.error(`Failed to delete account ${accountId}:`, error.message);
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
        return;
      }

      // Enforce minimum interval between connection attempts
      const lastAttempt = this.lastConnectionAttempt.get(accountId);
      if (lastAttempt) {
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

      const account = await db.getAccountById(accountId);
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
      setTimeout(() => this.connectionLocks.delete(accountId), 5000);

      logger.info(`Connection initiated for account ${accountId}`);
      
      return sock;
    } catch (error) {
      this.connectionLocks.delete(accountId);
      logger.error(`Failed to connect account ${accountId}:`, error.message);
      this.connectionStates.set(accountId, { status: 'error', error: error.message });
      await db.updateAccount(accountId, { status: 'error', error_message: error.message });
      throw error;
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
          // Generate QR code
          const qrDataUrl = await qrcode.toDataURL(qr);
          this.connectionStates.set(accountId, { status: 'qr_ready', qr: qrDataUrl });
          
          await db.updateAccount(accountId, { 
            status: 'qr_ready', 
            qr_code: qrDataUrl 
          });

        this.emit('qr-update', { accountId, qr: qrDataUrl });
        logger.info(`QR code generated for account ${accountId}`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || '';
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(`Connection closed for account ${accountId}: ${statusCode} - ${errorMessage}`);

        // Release connection lock
        this.connectionLocks.delete(accountId);

        // Check if account was deleted - don't try to reconnect or update DB
        if (this.deletedAccounts.has(accountId)) {
          logger.info(`Account ${accountId} was deleted, skipping reconnection`);
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
          this.scheduleReconnect(accountId, 60000);
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
        } else if (shouldReconnect) {
          // Standard reconnection with exponential backoff
          const attempts = this.reconnectAttempts.get(accountId) || 0;
          
          if (attempts < this.maxReconnectAttempts) {
            this.reconnectAttempts.set(accountId, attempts + 1);
            this.metrics.reconnections++;
            
            // Exponential backoff with jitter: 30s, 60s, 120s, 240s, 480s + random 0-10s
            const baseDelay = Math.min(30000 * Math.pow(2, attempts), 480000);
            const jitter = Math.floor(Math.random() * 10000);
            const delay = baseDelay + jitter;
            
            logger.info(`Reconnecting account ${accountId} in ${delay}ms (attempt ${attempts + 1}/${this.maxReconnectAttempts})`);
            this.scheduleReconnect(accountId, delay);
          } else {
            logger.error(`Max reconnection attempts reached for account ${accountId}`);
            this.connectionStates.set(accountId, { status: 'error', error: 'Max reconnection attempts reached' });
            await db.updateAccount(accountId, { status: 'error', error_message: 'Max reconnection attempts reached' })
              .catch(e => logger.warn(`Failed to update account status: ${e.message}`));
            this.emit('account-status', { accountId, status: 'error', message: 'Max reconnection attempts - please reconnect manually' });
          }
        }
      }

      if (connection === 'open') {
        // Successfully connected - reset all error tracking
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
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue; // Skip own messages

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
      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');

      // Send read receipt (blue ticks) for the incoming message
      try {
        await sock.readMessages([msg.key]);
      } catch (readErr) {
        logger.debug(`Could not send read receipt: ${readErr.message}`);
      }
      
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
      }

      if (!messageText) return;

      logger.info(`Message received from ${contactId}: ${messageText.substring(0, 50)}...`);

      // Save to conversation history (don't block webhook if this fails)
      try {
        await db.addConversationMessage(accountId, contactId, 'incoming', messageText, messageType);
      } catch (dbErr) {
        logger.error(`Failed to save conversation: ${dbErr.message}`);
      }

      // Dispatch webhook with both phone and JID for flexibility
      // Note: When isLidSender is true, 'from' contains the LID (not a real phone number)
      // Always use 'fromJid' with the 'jid' parameter in API calls to reply
      logger.info(`Dispatching webhook for account ${accountId}, event: message`);
      
      try {
        await webhookDeliveryService.dispatch(accountId, 'message', {
          messageId: msg.key.id,
          from: contactId,
          fromJid: remoteJid,
          isLidSender: isLidFormat,  // true = 'from' is LID, not a real phone number
          message: messageText,
          messageType,
          isGroup,
          timestamp: msg.messageTimestamp,
          pushName: msg.pushName || 'Unknown'
        });
        logger.info(`Webhook dispatched successfully for account ${accountId}`);
      } catch (webhookErr) {
        logger.error(`Webhook dispatch failed: ${webhookErr.message}`);
      }

      // AI Auto-reply (only for text messages, non-group)
      if (messageType === 'text' && !isGroup) {
        const aiReply = await aiAutoReply.generateReply({
          accountId,
          contactId,
          message: messageText
        });

        if (aiReply) {
          // Use the replyJid to send response (works with both LID and phone JIDs)
          await this.sendMessageToJid(accountId, replyJid, aiReply);
        }
      }
    } catch (error) {
      logger.error(`Error handling message for account ${accountId}:`, error.message);
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

    this.connectionStates.delete(accountId);

    if (updateDb) {
      await db.updateAccount(accountId, { status: 'disconnected' });
      this.emit('account-status', { accountId, status: 'disconnected' });
    }

    logger.info(`Account ${accountId} disconnected`);
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
   * Reconnect account
   */
  async reconnect(accountId) {
    this.reconnectAttempts.delete(accountId);
    await this.disconnect(accountId, false);
    return this.connect(accountId);
  }

  /**
   * Get QR code for account
   */
  async getQrCode(accountId) {
    const state = this.connectionStates.get(accountId);
    if (state?.qr) {
      return state.qr;
    }

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
  }
}

// Export singleton instance
module.exports = new WhatsAppManager();
