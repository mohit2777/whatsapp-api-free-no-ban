/**
 * WhatsApp Multi-Automation API
 * Main Application Entry Point
 * 
 * A self-hosted WhatsApp Business API alternative
 */

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const os = require('os');
require('dotenv').config();
const pg = require('pg');
const pgSession = require('connect-pg-simple')(session);

const { requireAuth, requireGuest, checkSessionTimeout, login, logout, getCurrentUser } = require('./middleware/auth');
const { db, supabase, MissingWebhookQueueTableError } = require('./config/database');
const whatsappManager = require('./utils/whatsappManager');
const webhookDeliveryService = require('./utils/webhookDeliveryService');
const aiAutoReply = require('./utils/aiAutoReply');
const logger = require('./utils/logger');
const { validate, schemas } = require('./utils/validator');
const { apiLimiter, authLimiter, messageLimiter, webhookLimiter, accountLimiter } = require('./utils/rateLimiter');

// ============================================================================
// GLOBAL ERROR HANDLERS
// ============================================================================

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
  // Don't exit - just log the error
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // For critical errors, we might want to exit
  if (error.message?.includes('FATAL')) {
    process.exit(1);
  }
});

// ============================================================================
// APP SETUP
// ============================================================================

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET', 'POST']
  }
});

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

app.use(compression());
app.use(cors({ origin: process.env.NODE_ENV === 'production' ? false : '*', credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// File uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// SESSION CONFIGURATION
// ============================================================================

let sessionStore = null;

// Only use PostgreSQL if DATABASE_URL is set AND looks valid (not a placeholder)
const dbUrl = process.env.DATABASE_URL;
const isValidDbUrl = dbUrl && (
  (dbUrl.includes('://') && 
  !dbUrl.includes('user:password') && 
  !dbUrl.includes('@host:') &&
  !dbUrl.includes('localhost')) || (process.env.NODE_ENV !== 'production')
);

if (isValidDbUrl) {
  try {
    const pgPool = new pg.Pool({
      connectionString: dbUrl,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 60000,
      max: 3
    });

    pgPool.on('error', (err) => {
      logger.warn('Session DB pool error:', err.message);
    });

    sessionStore = new pgSession({
      pool: pgPool,
      tableName: 'session',
      createTableIfMissing: true,
      pruneSessionInterval: 60 * 15
    });

    logger.info('Using PostgreSQL for session storage');
  } catch (e) {
    logger.warn('PostgreSQL session setup failed, using MemoryStore:', e.message);
  }
}

if (!sessionStore) {
  sessionStore = new session.MemoryStore();
  logger.info('Using MemoryStore for sessions');
}

const sessionSecret = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
const useSecureCookies = process.env.SESSION_COOKIE_SECURE === 'true';

app.use(session({
  store: sessionStore,
  secret: sessionSecret,
  name: 'wa.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: useSecureCookies,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: useSecureCookies ? 'strict' : 'lax'
  }
}));

app.use(checkSessionTimeout);

// ============================================================================
// SOCKET.IO
// ============================================================================

whatsappManager.setSocketIO(io);

io.on('connection', (socket) => {
  logger.debug(`Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    logger.debug(`Client disconnected: ${socket.id}`);
  });

  socket.on('subscribe-account', (accountId) => {
    // Validate accountId format to prevent room pollution
    if (!accountId || typeof accountId !== 'string' || accountId.length > 100) {
      logger.warn(`Invalid accountId in subscribe-account from ${socket.id}`);
      return;
    }
    socket.join(`account-${accountId}`);
  });
});

// ============================================================================
// AUTHENTICATION ROUTES
// ============================================================================

app.get('/login', requireGuest, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/api/auth/login', authLimiter, validate(schemas.login), login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/user', getCurrentUser);

// ============================================================================
// DASHBOARD ROUTES
// ============================================================================

app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// ============================================================================
// HEALTH CHECK & KEEPALIVE
// ============================================================================

// Simple ping for basic health checks
app.get('/ping', (req, res) => res.send('pong'));

// Keepalive endpoint - trigger this with a cron job (GET request) to prevent Render from sleeping
// Works with n8n Cron Trigger → HTTP Request Node (GET to this URL)
app.get('/keepalive', (req, res) => {
  const uptime = process.uptime();
  const metrics = whatsappManager.getMetrics();
  
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(uptime),
    uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
    connections: metrics.activeConnections,
    messagesSent: metrics.messagesSent,
    messagesReceived: metrics.messagesReceived
  });
  
  logger.debug('Keepalive ping received');
});

app.get('/api/health', async (req, res) => {
  try {
    const queueStatus = db.getQueueStatus();
    const cacheStats = db.getCacheStats();
    const metrics = whatsappManager.getMetrics();

    // Use in-memory webhook delivery stats (not the DB table which was removed)
    const webhookQueue = webhookDeliveryService.getStats();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      nodeVersion: process.version,
      memory: process.memoryUsage(),
      systemMemory: {
        total: os.totalmem(),
        free: os.freemem()
      },
      queue: queueStatus,
      cache: cacheStats,
      webhookQueue: {
        queueSize: webhookQueue.total || 0,
        isProcessing: (webhookQueue.processing || 0) > 0,
        delivered: Math.max(0, (webhookQueue.total || 0) - (webhookQueue.pending || 0) - (webhookQueue.processing || 0)),
        failed: webhookQueue.retrying || 0,
        pending: webhookQueue.pending || 0,
        maxSize: webhookQueue.maxSize || 1000
      },
      metrics
    });
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({ status: 'error', message: 'Health check failed' });
  }
});

// ============================================================================
// ACCOUNTS API
// ============================================================================

app.get('/api/accounts', requireAuth, apiLimiter, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    const aiConfigs = await db.getAllAiConfigs();
    
    // Create a map of account_id to ai_active status
    const aiActiveMap = {};
    aiConfigs.forEach(config => {
      aiActiveMap[config.account_id] = config.is_active;
    });

    const enrichedAccounts = accounts.map(account => {
      const runtimeStatus = whatsappManager.getAccountStatus(account.id);
      return {
        ...account,
        runtimeStatus: runtimeStatus.status,
        ai_active: aiActiveMap[account.id],
        session_data: undefined // Don't expose session data
      };
    });

    res.json({ success: true, accounts: enrichedAccounts });
  } catch (error) {
    logger.error('Error fetching accounts:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch accounts' });
  }
});

app.post('/api/accounts', requireAuth, accountLimiter, validate(schemas.createAccount), async (req, res) => {
  try {
    const { name, description } = req.body;
    const account = await whatsappManager.createAccount(name, description);
    res.status(201).json({ success: true, account });
  } catch (error) {
    logger.error('Error creating account:', error);
    res.status(500).json({ success: false, error: 'Failed to create account' });
  }
});

app.get('/api/accounts/:id', requireAuth, apiLimiter, async (req, res) => {
  try {
    const account = await db.getAccountById(req.params.id);
    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    const runtimeStatus = whatsappManager.getAccountStatus(account.id);
    res.json({
      success: true,
      account: {
        ...account,
        runtimeStatus: runtimeStatus.status,
        session_data: undefined
      }
    });
  } catch (error) {
    logger.error('Error fetching account:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch account' });
  }
});

app.delete('/api/accounts/:id', requireAuth, accountLimiter, async (req, res) => {
  try {
    await whatsappManager.deleteAccount(req.params.id);
    res.json({ success: true, message: 'Account deleted' });
  } catch (error) {
    logger.error('Error deleting account:', error);
    res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
});

app.post('/api/accounts/:id/reconnect', requireAuth, accountLimiter, async (req, res) => {
  try {
    await whatsappManager.reconnect(req.params.id);
    res.json({ success: true, message: 'Reconnection initiated' });
  } catch (error) {
    logger.error('Error reconnecting:', error);
    res.status(500).json({ success: false, error: 'Failed to reconnect' });
  }
});

app.get('/api/accounts/:id/qr', requireAuth, apiLimiter, async (req, res) => {
  try {
    const qr = await whatsappManager.getQrCode(req.params.id);
    if (qr) {
      res.json({ success: true, qr });
    } else {
      res.json({ success: false, message: 'QR code not available' });
    }
  } catch (error) {
    logger.error('Error fetching QR:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch QR code' });
  }
});

app.post('/api/accounts/:id/regenerate-api-key', requireAuth, accountLimiter, async (req, res) => {
  try {
    const newApiKey = await whatsappManager.regenerateApiKey(req.params.id);
    res.json({ success: true, api_key: newApiKey });
  } catch (error) {
    logger.error('Error regenerating API key:', error);
    res.status(500).json({ success: false, error: 'Failed to regenerate API key' });
  }
});

// ============================================================================
// MESSAGING API (API Key Auth)
// ============================================================================

app.post('/api/send', messageLimiter, validate(schemas.sendMessage), async (req, res) => {
  try {
    const { api_key, to, message } = req.body;

    logger.info(`[API] /api/send called - to: ${to}, message length: ${message.length}`);

    const account = await db.getAccountByApiKey(api_key);
    if (!account) {
      logger.warn(`[API] Invalid API key`);
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    if (account.status !== 'ready') {
      logger.warn(`[API] Account not ready: ${account.status}`);
      return res.status(400).json({ success: false, error: 'Account not connected' });
    }

    logger.info(`[API] Sending message via account ${account.id}`);
    // Auto-detect if 'to' is a JID (contains @) or phone number
    const result = await whatsappManager.sendMessageAuto(account.id, to, message);
    
    logger.info(`[API] Message sent successfully: ${result.messageId}`);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[API] Error sending message:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Failed to send message' });
  }
});

// Send media via file upload
app.post('/api/send-media', messageLimiter, upload.single('media'), async (req, res) => {
  try {
    const { api_key, to, caption, mediaType } = req.body;

    logger.info(`[API] /api/send-media called - to: ${to}, file: ${req.file?.originalname}, type: ${mediaType}`);

    if (!api_key) {
      logger.warn('[API] Missing api_key');
      return res.status(400).json({ success: false, error: 'api_key is required' });
    }

    if (!req.file) {
      logger.warn('[API] No media file provided');
      return res.status(400).json({ success: false, error: 'No media file provided' });
    }

    if (!to) {
      logger.warn('[API] Missing to field');
      return res.status(400).json({ success: false, error: 'Missing required field: to (phone number or JID)' });
    }

    const account = await db.getAccountByApiKey(api_key);
    if (!account) {
      logger.warn('[API] Invalid API key');
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    if (account.status !== 'ready') {
      logger.warn(`[API] Account not ready: ${account.status}`);
      return res.status(400).json({ success: false, error: 'Account not connected' });
    }

    logger.info(`[API] Sending media via account ${account.id}`);
    const result = await whatsappManager.sendMedia(
      account.id,
      to,
      req.file.buffer,
      mediaType || 'document',
      caption || '',
      req.file.mimetype,
      req.file.originalname
    );

    logger.info(`[API] Media sent successfully: ${result.messageId}`);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[API] Error sending media:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Failed to send media' });
  }
});

// Send media via Base64 or URL
app.post('/api/send-media-url', messageLimiter, async (req, res) => {
  try {
    const { api_key, to, caption, mediaType, mediaUrl, mediaBase64, mimetype, filename } = req.body;

    logger.info(`[API] /api/send-media-url called - to: ${to}, type: ${mediaType}, hasUrl: ${!!mediaUrl}, hasBase64: ${!!mediaBase64}`);

    if (!api_key) {
      logger.warn('[API] Missing api_key');
      return res.status(400).json({ success: false, error: 'api_key is required' });
    }

    if (!to) {
      logger.warn('[API] Missing to field');
      return res.status(400).json({ success: false, error: 'to is required (phone number or JID)' });
    }

    if (!mediaUrl && !mediaBase64) {
      logger.warn('[API] Missing both mediaUrl and mediaBase64');
      return res.status(400).json({ success: false, error: 'Either mediaUrl or mediaBase64 is required' });
    }

    const account = await db.getAccountByApiKey(api_key);
    if (!account) {
      logger.warn('[API] Invalid API key');
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    if (account.status !== 'ready') {
      logger.warn(`[API] Account not ready: ${account.status}`);
      return res.status(400).json({ success: false, error: 'Account not connected' });
    }

    let mediaBuffer;
    let detectedMimetype = mimetype;

    if (mediaBase64) {
      // Handle base64 encoded media
      // Remove data URL prefix if present (e.g., "data:image/png;base64,")
      const base64Data = mediaBase64.replace(/^data:[^;]+;base64,/, '');
      mediaBuffer = Buffer.from(base64Data, 'base64');
      
      // Try to detect mimetype from data URL if not provided
      if (!detectedMimetype && mediaBase64.startsWith('data:')) {
        const match = mediaBase64.match(/^data:([^;]+);base64,/);
        if (match) detectedMimetype = match[1];
      }
    } else if (mediaUrl) {
      // SSRF protection: only allow http/https and block internal IPs
      const parsedUrl = new URL(mediaUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({ success: false, error: 'Only http/https URLs are allowed' });
      }
      const hostname = parsedUrl.hostname.toLowerCase();
      const blockedPatterns = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '192.168.', '169.254.', 'metadata.google', 'metadata.aws', '[::1]', 'fd', 'fc00'];
      if (blockedPatterns.some(p => hostname.startsWith(p) || hostname === p || hostname.includes(p))) {
        return res.status(400).json({ success: false, error: 'Internal/private URLs are not allowed' });
      }

      const axios = require('axios');
      const response = await axios.get(mediaUrl, { 
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 50 * 1024 * 1024, // 50MB limit
        maxRedirects: 3
      });
      mediaBuffer = Buffer.from(response.data);
      detectedMimetype = detectedMimetype || response.headers['content-type'];
    }

    // Default mimetype based on media type
    if (!detectedMimetype) {
      const mimetypeDefaults = {
        image: 'image/jpeg',
        video: 'video/mp4',
        audio: 'audio/mp4',
        document: 'application/octet-stream'
      };
      detectedMimetype = mimetypeDefaults[mediaType] || 'application/octet-stream';
    }

    // 'to' can be phone number or JID - sendMedia handles both
    const result = await whatsappManager.sendMedia(
      account.id,
      to,
      mediaBuffer,
      mediaType || 'document',
      caption || '',
      detectedMimetype,
      filename || 'file'
    );

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Error sending media:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to send media' });
  }
});

// ============================================================================
// WEBHOOKS API
// ============================================================================

app.get('/api/accounts/:id/webhooks', requireAuth, apiLimiter, async (req, res) => {
  try {
    const webhooks = await db.getWebhooks(req.params.id);
    res.json({ success: true, webhooks });
  } catch (error) {
    logger.error('Error fetching webhooks:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch webhooks' });
  }
});

app.post('/api/accounts/:id/webhooks', requireAuth, webhookLimiter, validate(schemas.webhook), async (req, res) => {
  try {
    const webhook = await db.createWebhook({
      account_id: req.params.id,
      ...req.body
    });
    res.status(201).json({ success: true, webhook });
  } catch (error) {
    logger.error('Error creating webhook:', error);
    res.status(500).json({ success: false, error: 'Failed to create webhook' });
  }
});

app.put('/api/webhooks/:id', requireAuth, webhookLimiter, validate(schemas.webhook), async (req, res) => {
  try {
    const webhook = await db.updateWebhook(req.params.id, req.body);
    res.json({ success: true, webhook });
  } catch (error) {
    logger.error('Error updating webhook:', error);
    res.status(500).json({ success: false, error: 'Failed to update webhook' });
  }
});

app.delete('/api/webhooks/:id', requireAuth, webhookLimiter, async (req, res) => {
  try {
    await db.deleteWebhook(req.params.id);
    res.json({ success: true, message: 'Webhook deleted' });
  } catch (error) {
    logger.error('Error deleting webhook:', error);
    res.status(500).json({ success: false, error: 'Failed to delete webhook' });
  }
});

app.post('/api/webhooks/:id/test', requireAuth, webhookLimiter, async (req, res) => {
  try {
    const webhook = await db.getWebhookById(req.params.id);
    if (!webhook) {
      return res.status(404).json({ success: false, error: 'Webhook not found' });
    }

    const testPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      message: 'This is a test webhook delivery'
    };

    const result = await webhookDeliveryService.deliverWebhook(webhook, testPayload);
    res.json({ success: result.success, ...result });
  } catch (error) {
    logger.error('Error testing webhook:', error);
    res.status(500).json({ success: false, error: 'Failed to test webhook' });
  }
});

// ============================================================================
// AI CONFIG API
// ============================================================================

app.get('/api/accounts/:id/ai-config', requireAuth, apiLimiter, async (req, res) => {
  try {
    const config = await aiAutoReply.getConfig(req.params.id);
    res.json({ success: true, config: config || null });
  } catch (error) {
    logger.error('Error fetching AI config:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch AI config' });
  }
});

app.post('/api/accounts/:id/ai-config', requireAuth, apiLimiter, validate(schemas.aiConfig), async (req, res) => {
  try {
    const config = await aiAutoReply.saveConfig(req.params.id, req.body);
    res.json({ success: true, config });
  } catch (error) {
    logger.error('Error saving AI config:', error);
    res.status(500).json({ success: false, error: 'Failed to save AI config' });
  }
});

app.delete('/api/accounts/:id/ai-config', requireAuth, apiLimiter, async (req, res) => {
  try {
    await aiAutoReply.deleteConfig(req.params.id);
    res.json({ success: true, message: 'AI config deleted' });
  } catch (error) {
    logger.error('Error deleting AI config:', error);
    res.status(500).json({ success: false, error: 'Failed to delete AI config' });
  }
});

// ============================================================================
// ERROR HANDLER
// ============================================================================

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ============================================================================
// STARTUP
// ============================================================================

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // Start webhook delivery service
    webhookDeliveryService.start();

    // Initialize WhatsApp accounts
    await whatsappManager.initializeAccounts();

    // Start server
    server.listen(PORT, () => {
      logger.info(`🚀 WhatsApp Multi-Automation API running on port ${PORT}`);
      logger.info(`📊 Dashboard: http://localhost:${PORT}/dashboard`);

      // Self-ping keep-alive: prevents Render free tier from spinning down
      // after 15 minutes of inactivity (which kills WhatsApp connections).
      // Pings every 13 minutes so the service stays warm continuously.
      const KEEP_ALIVE_INTERVAL = 13 * 60 * 1000; // 13 minutes
      setInterval(async () => {
        try {
          const url = process.env.RENDER_EXTERNAL_URL
            ? `${process.env.RENDER_EXTERNAL_URL}/keepalive`
            : `http://localhost:${PORT}/keepalive`;
          const http = require(url.startsWith('https') ? 'https' : 'http');
          http.get(url, (res) => {
            res.resume(); // consume response to free memory
            logger.debug(`Keep-alive ping OK (status ${res.statusCode})`);
          }).on('error', (err) => {
            logger.debug(`Keep-alive ping failed: ${err.message}`);
          });
        } catch (e) {
          logger.debug(`Keep-alive error: ${e.message}`);
        }
      }, KEEP_ALIVE_INTERVAL).unref();
      logger.info(`🔄 Keep-alive self-ping enabled (every ${KEEP_ALIVE_INTERVAL / 60000} min)`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down...`);
  webhookDeliveryService.stop();
  await whatsappManager.shutdown();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  // Force exit after 15 seconds if server.close hangs
  setTimeout(() => {
    logger.warn('Forced exit after shutdown timeout');
    process.exit(1);
  }, 15000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

start();
