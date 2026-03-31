/**
 * Logger Utility
 * Structured logging with Winston
 * 
 * Levels: error, warn, info, debug
 * Set LOG_LEVEL env var to control verbosity (default: debug in dev, info in prod).
 * Every log line includes an ISO timestamp and uppercase level tag.
 * Metadata objects are JSON-serialized inline for easy grep/search.
 */

const winston = require('winston');

const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const customFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
  // Append structured metadata if present (removes noise of empty objects)
  const metaKeys = Object.keys(metadata);
  if (metaKeys.length > 0) {
    // Truncate very large metadata to prevent log flooding
    const serialized = JSON.stringify(metadata);
    msg += serialized.length > 2000 ? ` ${serialized.slice(0, 2000)}...(truncated)` : ` ${serialized}`;
  }
  return msg;
});

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    customFormat
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        customFormat
      )
    })
  ],
  // Don't exit on error
  exitOnError: false
});

// Add file transport in production for persistent debugging
if (process.env.NODE_ENV === 'production' && process.env.LOG_TO_FILE === 'true') {
  logger.add(new winston.transports.File({
    filename: 'logs/error.log',
    level: 'error',
    maxsize: 5242880, // 5MB
    maxFiles: 5
  }));
  logger.add(new winston.transports.File({
    filename: 'logs/combined.log',
    maxsize: 5242880,
    maxFiles: 5
  }));
}

// Log the logger's own config at startup (helps debug "why aren't my logs showing?")
logger.info(`[LOGGER] Initialized — level=${logLevel} env=${process.env.NODE_ENV || 'development'} fileLogging=${process.env.LOG_TO_FILE === 'true'}`);

module.exports = logger;
