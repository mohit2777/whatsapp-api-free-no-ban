/**
 * Database Configuration and Helper Functions
 * Supports Supabase and direct PostgreSQL connections
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');
require('dotenv').config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  logger.error('Missing Supabase configuration. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

// Create Supabase client
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: false
  },
  db: {
    schema: 'public'
  },
  global: {
    headers: {
      'x-application-name': 'wa-multi-automation-v4'
    }
  }
});

// ============================================================================
// CACHE MANAGER
// ============================================================================

class CacheManager {
  constructor(maxSize = 1000, defaultTTL = 60000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
    this.stats = { hits: 0, misses: 0 };
  }

  set(key, value, ttl = this.defaultTTL) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiry: Date.now() + ttl });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) {
      this.stats.misses++;
      return null;
    }
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    return item.value;
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  invalidatePattern(pattern) {
    const regex = new RegExp(pattern);
    for (const key of this.cache.keys()) {
      if (regex.test(key)) this.cache.delete(key);
    }
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0
    };
  }
}

const cacheManager = new CacheManager(
  parseInt(process.env.QUERY_CACHE_SIZE) || 1000,
  parseInt(process.env.CACHE_TTL) || 300000
);

// ============================================================================
// ERROR TYPES
// ============================================================================

class MissingWebhookQueueTableError extends Error {
  constructor(message) {
    super(message || 'webhook_delivery_queue table not found');
    this.name = 'MissingWebhookQueueTableError';
  }
}

// ============================================================================
// RETRY HELPER
// ============================================================================

async function withRetry(fn, operationName, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable =
        error?.message?.includes('520') ||
        error?.message?.includes('502') ||
        error?.message?.includes('503') ||
        error?.message?.includes('504') ||
        error?.message?.includes('fetch failed') ||
        error?.message?.includes('ECONNRESET');

      if (!isRetryable || attempt === maxRetries) throw lastError;

      const delay = 1000 * Math.pow(2, attempt - 1);
      logger.warn(`[DB Retry] ${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// ============================================================================
// DATABASE HELPER OBJECT
// ============================================================================

const db = {
  // =====================
  // ACCOUNTS
  // =====================
  async getAccounts() {
    const cached = cacheManager.get('accounts');
    if (cached) return cached;

    const { data, error } = await withRetry(
      () => supabase.from('whatsapp_accounts').select('*').order('created_at', { ascending: false }),
      'getAccounts'
    );

    if (error) throw error;
    cacheManager.set('accounts', data);
    return data;
  },

  async getAccountById(id) {
    const cached = cacheManager.get(`account:${id}`);
    if (cached) return cached;

    const { data, error } = await withRetry(
      () => supabase.from('whatsapp_accounts').select('*').eq('id', id).single(),
      'getAccountById'
    );

    if (error && error.code !== 'PGRST116') throw error;
    if (data) cacheManager.set(`account:${id}`, data, 60000);
    return data;
  },

  async getAccountByApiKey(apiKey) {
    if (!apiKey) return null;
    
    const cached = cacheManager.get(`apikey:${apiKey}`);
    if (cached) return cached;

    const { data, error } = await withRetry(
      () => supabase.from('whatsapp_accounts').select('*').eq('api_key', apiKey).single(),
      'getAccountByApiKey'
    );

    if (error && error.code !== 'PGRST116') throw error;
    if (data) cacheManager.set(`apikey:${apiKey}`, data, 120000);
    return data;
  },

  async createAccount(account) {
    const { data, error } = await withRetry(
      () => supabase.from('whatsapp_accounts').insert(account).select().single(),
      'createAccount'
    );

    if (error) throw error;
    cacheManager.invalidate('accounts');
    return data;
  },

  async updateAccount(id, updates) {
    const { data, error } = await withRetry(
      () => supabase.from('whatsapp_accounts').update(updates).eq('id', id).select().single(),
      'updateAccount'
    );

    if (error) throw error;
    cacheManager.invalidate('accounts');
    cacheManager.invalidate(`account:${id}`);
    cacheManager.invalidatePattern(`apikey:`);
    return data;
  },

  async deleteAccount(id) {
    const { error } = await withRetry(
      () => supabase.from('whatsapp_accounts').delete().eq('id', id),
      'deleteAccount'
    );

    if (error) throw error;
    cacheManager.invalidate('accounts');
    cacheManager.invalidate(`account:${id}`);
    cacheManager.invalidatePattern(`apikey:`);
    return true;
  },

  // =====================
  // WEBHOOKS
  // =====================
  async getWebhooks(accountId) {
    const { data, error } = await withRetry(
      () => supabase.from('webhooks').select('*').eq('account_id', accountId).order('created_at'),
      'getWebhooks'
    );

    if (error) throw error;
    return data || [];
  },

  async getActiveWebhooks(accountId) {
    const { data, error } = await withRetry(
      () => supabase.from('webhooks').select('*').eq('account_id', accountId).eq('is_active', true),
      'getActiveWebhooks'
    );

    if (error) throw error;
    return data || [];
  },

  async getWebhookById(id) {
    const { data, error } = await withRetry(
      () => supabase.from('webhooks').select('*').eq('id', id).single(),
      'getWebhookById'
    );

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async createWebhook(webhook) {
    const { data, error } = await withRetry(
      () => supabase.from('webhooks').insert(webhook).select().single(),
      'createWebhook'
    );

    if (error) throw error;
    return data;
  },

  async updateWebhook(id, updates) {
    const { data, error } = await withRetry(
      () => supabase.from('webhooks').update(updates).eq('id', id).select().single(),
      'updateWebhook'
    );

    if (error) throw error;
    return data;
  },

  async deleteWebhook(id) {
    const { error } = await withRetry(
      () => supabase.from('webhooks').delete().eq('id', id),
      'deleteWebhook'
    );

    if (error) throw error;
    return true;
  },

  // =====================
  // WEBHOOK QUEUE
  // =====================
  async addToWebhookQueue(item) {
    const { data, error } = await supabase.from('webhook_delivery_queue').insert(item).select().single();
    if (error) {
      if (error.message?.includes('does not exist')) {
        throw new MissingWebhookQueueTableError();
      }
      throw error;
    }
    return data;
  },

  async getPendingWebhooks(limit = 50) {
    const { data, error } = await supabase
      .from('webhook_delivery_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('next_retry_at', new Date().toISOString())
      .order('created_at')
      .limit(limit);

    if (error) {
      if (error.message?.includes('does not exist')) {
        throw new MissingWebhookQueueTableError();
      }
      throw error;
    }
    return data || [];
  },

  async updateWebhookQueueItem(id, updates) {
    const { data, error } = await supabase
      .from('webhook_delivery_queue')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getWebhookQueueStats() {
    const { data, error } = await supabase
      .from('webhook_delivery_queue')
      .select('status')
      .then(result => {
        if (result.error) throw result.error;
        const stats = { pending: 0, processing: 0, success: 0, failed: 0, dead_letter: 0, total: 0 };
        (result.data || []).forEach(item => {
          stats[item.status] = (stats[item.status] || 0) + 1;
          stats.total++;
        });
        return { data: stats, error: null };
      });

    if (error) {
      if (error.message?.includes('does not exist')) {
        throw new MissingWebhookQueueTableError();
      }
      throw error;
    }
    return data;
  },

  // =====================
  // AI CONFIG
  // =====================
  async getAiConfig(accountId) {
    const cached = cacheManager.get(`ai:${accountId}`);
    if (cached) return cached;

    const { data, error } = await withRetry(
      () => supabase.from('ai_configs').select('*').eq('account_id', accountId).single(),
      'getAiConfig'
    );

    if (error && error.code !== 'PGRST116') throw error;
    if (data) cacheManager.set(`ai:${accountId}`, data, 60000);
    return data;
  },

  async getAllAiConfigs() {
    const { data, error } = await withRetry(
      () => supabase.from('ai_configs').select('*'),
      'getAllAiConfigs'
    );

    if (error) throw error;
    return data || [];
  },

  async saveAiConfig(config) {
    const { data, error } = await withRetry(
      () => supabase.from('ai_configs').upsert(config, { onConflict: 'account_id' }).select().single(),
      'saveAiConfig'
    );

    if (error) throw error;
    cacheManager.invalidate(`ai:${config.account_id}`);
    return data;
  },

  async deleteAiConfig(accountId) {
    const { error } = await withRetry(
      () => supabase.from('ai_configs').delete().eq('account_id', accountId),
      'deleteAiConfig'
    );

    if (error) throw error;
    cacheManager.invalidate(`ai:${accountId}`);
    return true;
  },

  // =====================
  // CONVERSATION HISTORY
  // =====================
  async addConversationMessage(accountId, contactId, direction, message, messageType = 'text') {
    const { error } = await supabase.from('conversation_history').insert({
      account_id: accountId,
      contact_id: contactId,
      direction,
      message,
      message_type: messageType
    });

    if (error) logger.warn('Failed to save conversation:', error.message);
  },

  async getConversationHistory(accountId, contactId, limit = 10) {
    const { data, error } = await supabase
      .from('conversation_history')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.warn('Failed to get conversation history:', error.message);
      return [];
    }
    return (data || []).reverse();
  },

  // =====================
  // CACHE STATS
  // =====================
  getCacheStats() {
    return cacheManager.getStats();
  },

  getQueueStatus() {
    return {
      cacheSize: cacheManager.cache.size,
      maxCacheSize: cacheManager.maxSize
    };
  },

  clearCache() {
    cacheManager.clear();
  }
};

module.exports = {
  db,
  supabase,
  MissingWebhookQueueTableError
};
