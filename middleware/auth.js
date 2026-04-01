/**
 * Authentication Middleware
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');

// Session timeout in milliseconds (24 hours)
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

/**
 * Build a fingerprint string from the request's User-Agent and IP.
 * Used to detect session hijacking — if the fingerprint changes
 * between requests, the session was likely stolen.
 */
function buildSessionFingerprint(req) {
  const ua = req.headers['user-agent'] || 'unknown';
  return crypto.createHash('sha256').update(ua).digest('hex').slice(0, 16);
}

/**
 * Extract client info for logging
 */
function clientInfo(req) {
  return {
    ip: req.ip || req.connection?.remoteAddress || 'unknown',
    ua: (req.headers['user-agent'] || 'unknown').slice(0, 120),
    method: req.method,
    path: req.path,
    sessionId: req.sessionID ? req.sessionID.slice(0, 8) + '...' : 'none',
    reqId: req.id || '-'
  };
}

/**
 * Middleware: Require authenticated user
 */
function requireAuth(req, res, next) {
  const info = clientInfo(req);

  // No session at all
  if (!req.session) {
    logger.warn(`[AUTH] BLOCKED — no session object | ${info.method} ${info.path} | ip=${info.ip} reqId=${info.reqId}`);
    return respondUnauthorized(req, res, 'No session');
  }

  // Session exists but no user — not logged in
  if (!req.session.user) {
    logger.warn(`[AUTH] BLOCKED — no user in session | ${info.method} ${info.path} | ip=${info.ip} sid=${info.sessionId} reqId=${info.reqId}`);
    return respondUnauthorized(req, res, 'Not logged in');
  }

  // Session fingerprint check — detect hijacked sessions
  const currentFp = buildSessionFingerprint(req);
  if (req.session._fingerprint && req.session._fingerprint !== currentFp) {
    logger.error(`[AUTH] SESSION HIJACK DETECTED — fingerprint mismatch | expected=${req.session._fingerprint} got=${currentFp} | user=${req.session.user.username} ip=${info.ip} sid=${info.sessionId} reqId=${info.reqId}`);
    req.session.destroy((err) => {
      if (err) logger.error('[AUTH] Failed to destroy hijacked session:', err.message);
    });
    return respondUnauthorized(req, res, 'Session invalid');
  }

  // Session looks valid
  logger.debug(`[AUTH] ALLOWED — user=${req.session.user.username} | ${info.method} ${info.path} | ip=${info.ip} sid=${info.sessionId} reqId=${info.reqId}`);
  return next();
}

/**
 * Send appropriate unauthorized response (JSON for API, redirect for pages)
 */
function respondUnauthorized(req, res, reason) {
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Please log in to access this resource'
    });
  }
  // For page requests, redirect to login
  res.redirect('/login');
}

/**
 * Middleware: Require guest (not logged in)
 */
function requireGuest(req, res, next) {
  if (req.session && req.session.user) {
    logger.debug(`[AUTH] Guest check — user already logged in (${req.session.user.username}), redirecting to dashboard`);
    return res.redirect('/dashboard');
  }
  next();
}

/**
 * Middleware: Check session timeout
 */
function checkSessionTimeout(req, res, next) {
  if (req.session && req.session.user && req.session.lastActivity) {
    const now = Date.now();
    const elapsed = now - req.session.lastActivity;

    if (elapsed > SESSION_TIMEOUT) {
      const info = clientInfo(req);
      const elapsedHrs = (elapsed / 3600000).toFixed(1);
      logger.warn(`[AUTH] SESSION EXPIRED — user=${req.session.user.username} idle=${elapsedHrs}h | ${info.method} ${info.path} | ip=${info.ip} sid=${info.sessionId} reqId=${info.reqId}`);

      req.session.destroy((err) => {
        if (err) logger.error('[AUTH] Session destroy error on timeout:', err.message);
      });
      
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({
          success: false,
          error: 'Session expired',
          message: 'Your session has expired. Please log in again.'
        });
      }
      return res.redirect('/login');
    }
    
    // Update last activity
    req.session.lastActivity = now;
  }
  next();
}

/**
 * Login handler
 */
async function login(req, res) {
  const info = clientInfo(req);
  try {
    const { username, password } = req.body;

    logger.info(`[AUTH] Login attempt — username="${username}" | ip=${info.ip} ua="${info.ua}" reqId=${info.reqId}`);

    // Get credentials from environment
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      logger.error('[AUTH] ADMIN_PASSWORD not set in environment — login impossible');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error'
      });
    }

    // Validate credentials
    const usernameMatch = username === adminUsername;
    
    // Support both plain text and hashed passwords
    let passwordMatch = false;
    if (adminPassword.startsWith('$2a$') || adminPassword.startsWith('$2b$')) {
      passwordMatch = await bcrypt.compare(password, adminPassword);
    } else {
      passwordMatch = password === adminPassword;
    }

    if (!usernameMatch || !passwordMatch) {
      logger.warn(`[AUTH] LOGIN FAILED — username="${username}" usernameMatch=${usernameMatch} passwordMatch=${passwordMatch} | ip=${info.ip} ua="${info.ua}" reqId=${info.reqId}`);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Create session with fingerprint for hijack detection
    const fingerprint = buildSessionFingerprint(req);
    req.session.user = {
      username: adminUsername,
      role: 'admin',
      loginTime: Date.now()
    };
    req.session.lastActivity = Date.now();
    req.session._fingerprint = fingerprint;

    logger.info(`[AUTH] LOGIN SUCCESS — user=${adminUsername} | ip=${info.ip} sid=${req.sessionID?.slice(0, 8)}... fp=${fingerprint} reqId=${info.reqId}`);

    // Explicitly save session to the store before responding.
    // Without this, the client may redirect to /dashboard before the
    // session is persisted to PostgreSQL, causing requireAuth to fail.
    req.session.save((saveErr) => {
      if (saveErr) {
        logger.error(`[AUTH] Session save failed — ${saveErr.message} | user=${adminUsername} ip=${info.ip} reqId=${info.reqId}`);
        return res.status(500).json({
          success: false,
          error: 'Session initialization failed'
        });
      }

      res.json({
        success: true,
        message: 'Login successful',
        user: {
          username: adminUsername,
          role: 'admin'
        }
      });
    });
  } catch (error) {
    logger.error(`[AUTH] Login error — ${error.message} | ip=${info.ip} reqId=${info.reqId}`, error);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
}

/**
 * Logout handler
 */
function logout(req, res) {
  const info = clientInfo(req);
  const username = req.session?.user?.username || 'unknown';
  
  logger.info(`[AUTH] LOGOUT — user=${username} | ip=${info.ip} sid=${info.sessionId} reqId=${info.reqId}`);

  req.session.destroy((err) => {
    if (err) {
      logger.error(`[AUTH] Logout session destroy error for ${username}: ${err.message}`);
      return res.status(500).json({
        success: false,
        error: 'Logout failed'
      });
    }

    res.clearCookie('wa.sid');
    logger.info(`[AUTH] Logout complete — user=${username} cookie cleared`);

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  });
}

/**
 * Get current user
 */
function getCurrentUser(req, res) {
  const info = clientInfo(req);

  if (req.session && req.session.user) {
    logger.debug(`[AUTH] getCurrentUser — user=${req.session.user.username} | ip=${info.ip} reqId=${info.reqId}`);
    return res.json({
      success: true,
      user: req.session.user
    });
  }

  logger.debug(`[AUTH] getCurrentUser — not authenticated | ip=${info.ip} reqId=${info.reqId}`);
  res.status(401).json({
    success: false,
    error: 'Not authenticated'
  });
}

module.exports = {
  requireAuth,
  requireGuest,
  checkSessionTimeout,
  login,
  logout,
  getCurrentUser,
  buildSessionFingerprint
};
