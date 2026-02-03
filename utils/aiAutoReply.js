/**
 * AI Auto-Reply Service
 * Supports multiple AI providers: OpenAI, Anthropic, Gemini, Groq, OpenRouter
 */

const axios = require('axios');
const logger = require('./logger');
const { db } = require('../config/database');

class AiAutoReplyService {
  /**
   * Get AI configuration for an account
   */
  async getConfig(accountId) {
    return db.getAiConfig(accountId);
  }

  /**
   * Save AI configuration for an account
   */
  async saveConfig(accountId, payload) {
    const config = {
      account_id: accountId,
      provider: payload.provider,
      api_key: payload.api_key,
      model: payload.model,
      system_prompt: payload.system_prompt || '',
      temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.7,
      is_active: !!payload.is_active,
      memory_enabled: payload.memory_enabled !== false,
      memory_limit: typeof payload.memory_limit === 'number' ? payload.memory_limit : 10,
      updated_at: new Date().toISOString()
    };
    return db.saveAiConfig(config);
  }

  /**
   * Delete AI configuration for an account
   */
  async deleteConfig(accountId) {
    return db.deleteAiConfig(accountId);
  }

  /**
   * Generate AI reply for incoming message
   */
  async generateReply({ accountId, contactId, message }) {
    const config = await db.getAiConfig(accountId);
    
    if (!config || !config.is_active) {
      return null;
    }

    if (!config.api_key || !config.model || !config.provider) {
      logger.warn(`AI config incomplete for account ${accountId}`);
      return null;
    }

    // Get conversation history for context (respecting memory settings)
    let history = [];
    if (config.memory_enabled !== false) {
      const memoryLimit = config.memory_limit || 10;
      history = await db.getConversationHistory(accountId, contactId, memoryLimit);
    }

    const start = Date.now();
    let replyText = null;

    try {
      switch (config.provider) {
        case 'openai':
          replyText = await this.callOpenAI({ config, history, message });
          break;
        case 'anthropic':
          replyText = await this.callAnthropic({ config, history, message });
          break;
        case 'gemini':
          replyText = await this.callGemini({ config, history, message });
          break;
        case 'groq':
          replyText = await this.callGroq({ config, history, message });
          break;
        case 'openrouter':
        case 'openrouter-free':
          replyText = await this.callOpenRouter({ config, history, message });
          break;
        default:
          logger.warn(`Unsupported AI provider: ${config.provider}`);
          return null;
      }
    } catch (error) {
      logger.error(`AI reply error for account ${accountId}:`, error.response?.data || error.message);
      return null;
    }

    const latency = Date.now() - start;
    logger.info(`AI reply generated for ${accountId}/${contactId} in ${latency}ms`);
    
    return replyText || null;
  }

  /**
   * Build messages array for chat completions
   */
  buildMessages({ config, history, message }) {
    const messages = [];

    if (config.system_prompt) {
      messages.push({ role: 'system', content: config.system_prompt });
    }

    for (const h of history) {
      messages.push({
        role: h.direction === 'incoming' ? 'user' : 'assistant',
        content: h.message || ''
      });
    }

    messages.push({ role: 'user', content: message });
    return messages;
  }

  /**
   * OpenAI API call
   */
  async callOpenAI({ config, history, message }) {
    const messages = this.buildMessages({ config, history, message });
    
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: config.model,
        messages,
        temperature: config.temperature ?? 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return response.data.choices?.[0]?.message?.content?.trim() || null;
  }

  /**
   * Anthropic (Claude) API call
   */
  async callAnthropic({ config, history, message }) {
    const messages = [];

    for (const h of history) {
      messages.push({
        role: h.direction === 'incoming' ? 'user' : 'assistant',
        content: h.message || ''
      });
    }

    messages.push({ role: 'user', content: message });

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: config.model,
        max_tokens: 1024,
        system: config.system_prompt || undefined,
        messages
      },
      {
        headers: {
          'x-api-key': config.api_key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return response.data.content?.[0]?.text?.trim() || null;
  }

  /**
   * Google Gemini API call
   */
  async callGemini({ config, history, message }) {
    const contents = [];

    if (config.system_prompt) {
      contents.push({ role: 'user', parts: [{ text: config.system_prompt }] });
      contents.push({ role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] });
    }

    for (const h of history) {
      contents.push({
        role: h.direction === 'incoming' ? 'user' : 'model',
        parts: [{ text: h.message || '' }]
      });
    }

    contents.push({ role: 'user', parts: [{ text: message }] });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.api_key)}`;
    
    const response = await axios.post(
      url,
      {
        contents,
        generationConfig: {
          temperature: config.temperature ?? 0.7
        }
      },
      { timeout: 30000 }
    );

    return response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  }

  /**
   * Groq API call
   */
  async callGroq({ config, history, message }) {
    const messages = this.buildMessages({ config, history, message });
    
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: config.model,
        messages,
        temperature: config.temperature ?? 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return response.data.choices?.[0]?.message?.content?.trim() || null;
  }

  /**
   * OpenRouter API call
   */
  async callOpenRouter({ config, history, message }) {
    const messages = this.buildMessages({ config, history, message });
    
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: config.model,
        messages,
        temperature: config.temperature ?? 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://whatsapp-automation.app',
          'X-Title': 'WhatsApp Multi-Automation'
        },
        timeout: 30000
      }
    );

    return response.data.choices?.[0]?.message?.content?.trim() || null;
  }
}

module.exports = new AiAutoReplyService();
