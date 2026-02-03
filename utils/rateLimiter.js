/**
 * Rate Limiting Configuration
 */

const rateLimit = require('express-rate-limit');
const logger = require('./logger');

// Helper to create rate limiters
const createLimiter = (options) => {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(`Rate limit exceeded: ${req.ip} on ${req.path}`);
      res.status(429).json({
        success: false,
        error: 'Too many requests',
        message: `Please wait before making more requests. Limit: ${options.max} requests per ${options.windowMs / 1000} seconds.`
      });
    },
    ...options
  });
};

// General API rate limiter
const apiLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100 // 100 requests per minute
});

// Authentication rate limiter (stricter)
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10 // 10 login attempts per 15 minutes
});

// Message sending rate limiter
const messageLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 30 // 30 messages per minute
});

// Webhook rate limiter
const webhookLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60 // 60 webhook operations per minute
});

// Account operations rate limiter
const accountLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 20 // 20 account operations per minute
});

module.exports = {
  apiLimiter,
  authLimiter,
  messageLimiter,
  webhookLimiter,
  accountLimiter
};
