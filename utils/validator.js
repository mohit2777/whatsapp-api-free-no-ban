/**
 * Input Validation with Joi
 */

const Joi = require('joi');

// Validation schemas
const schemas = {
  // Authentication
  login: Joi.object({
    username: Joi.string().min(3).max(50).required(),
    password: Joi.string().min(6).max(100).required()
  }),

  // Account creation
  createAccount: Joi.object({
    name: Joi.string().min(1).max(255).required(),
    description: Joi.string().max(1000).optional().allow('')
  }),

  // Update account
  updateAccount: Joi.object({
    name: Joi.string().min(1).max(255).optional(),
    description: Joi.string().max(1000).optional().allow('')
  }),

  // Send message - 'to' accepts phone number with country code (e.g. "919876543210"),
  // or full JID (e.g. "919876543210@s.whatsapp.net", "120363123456@g.us")
  sendMessage: Joi.object({
    api_key: Joi.string().length(64).required(),
    to: Joi.string().min(5).max(100).required(),
    message: Joi.string().min(1).max(4096).required()
  }),

  // Send media (via file upload or /api/send-media)
  sendMedia: Joi.object({
    api_key: Joi.string().length(64).required(),
    to: Joi.string().min(5).max(100).required(),
    caption: Joi.string().max(1024).optional().allow(''),
    mediaType: Joi.string().valid('image', 'document', 'audio', 'video').required()
  }),

  // Send poll
  sendPoll: Joi.object({
    api_key: Joi.string().length(64).required(),
    to: Joi.string().min(5).max(100).required(),
    name: Joi.string().min(1).max(255).required(),
    options: Joi.array().items(Joi.string().min(1).max(100)).min(2).max(12).required(),
    selectableCount: Joi.number().integer().min(0).max(12).optional().default(0)
  }),

  // Webhook
  webhook: Joi.object({
    url: Joi.string().uri().max(500).required(),
    secret: Joi.string().max(255).optional().allow(''),
    events: Joi.array().items(Joi.string().valid('message', 'message.status', 'presence', 'connection', 'connection.update', 'presence.update', '*')).optional(),
    is_active: Joi.boolean().optional()
  }),

  // AI Config
  aiConfig: Joi.object({
    provider: Joi.string().valid('openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'openrouter-free').required(),
    api_key: Joi.string().min(10).max(255).required(),
    model: Joi.string().min(1).max(100).required(),
    system_prompt: Joi.string().max(4000).optional().allow(''),
    temperature: Joi.number().min(0).max(2).optional(),
    is_active: Joi.boolean().optional()
  }),

  // UUID parameter
  uuidParam: Joi.object({
    id: Joi.string().uuid().required()
  }),

  // Account ID parameter
  accountId: Joi.object({
    accountId: Joi.string().uuid().required()
  })
};

/**
 * Validation middleware factory
 * @param {Joi.Schema} schema - Joi schema to validate against
 * @param {string} property - Request property to validate ('body', 'query', 'params')
 */
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));

      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors
      });
    }

    // Replace with validated/sanitized values
    req[property] = value;
    next();
  };
}

module.exports = {
  validate,
  schemas
};
