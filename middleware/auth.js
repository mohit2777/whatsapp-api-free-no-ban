/**
 * Authentication Middleware
 */

const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');

// Session timeout in milliseconds (24 hours)
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

/**
 * Middleware: Require authenticated user
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  // Check if it's an API request
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Please log in to access this resource'
    });
  }

  // Redirect to login for page requests
  res.redirect('/login');
}

/**
 * Middleware: Require guest (not logged in)
 */
function requireGuest(req, res, next) {
  if (req.session && req.session.user) {
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
    if (now - req.session.lastActivity > SESSION_TIMEOUT) {
      req.session.destroy((err) => {
        if (err) logger.error('Session destroy error:', err);
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
  try {
    const { username, password } = req.body;

    // Get credentials from environment
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      logger.error('ADMIN_PASSWORD not set in environment');
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
      // Hashed password
      passwordMatch = await bcrypt.compare(password, adminPassword);
    } else {
      // Plain text password
      passwordMatch = password === adminPassword;
    }

    if (!usernameMatch || !passwordMatch) {
      logger.warn(`Failed login attempt for username: ${username}`);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Create session
    req.session.user = {
      username: adminUsername,
      role: 'admin',
      loginTime: Date.now()
    };
    req.session.lastActivity = Date.now();

    logger.info(`User ${adminUsername} logged in successfully`);

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        username: adminUsername,
        role: 'admin'
      }
    });
  } catch (error) {
    logger.error('Login error:', error);
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
  const username = req.session?.user?.username;
  
  req.session.destroy((err) => {
    if (err) {
      logger.error('Logout error:', err);
      return res.status(500).json({
        success: false,
        error: 'Logout failed'
      });
    }

    res.clearCookie('wa.sid');
    logger.info(`User ${username} logged out`);

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
  if (req.session && req.session.user) {
    return res.json({
      success: true,
      user: req.session.user
    });
  }

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
  getCurrentUser
};
