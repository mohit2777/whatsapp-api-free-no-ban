/**
 * Webhook Delivery Service
 * In-memory webhook queue with retries - no database storage
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('./logger');
const { db } = require('../config/database');

class WebhookDeliveryService {
  constructor() {
    this.queue = [];  // In-memory queue
    this.isProcessing = false;
    this.processInterval = null;
    this.maxRetries = 5;
    this.retryDelays = [
      1000,      // 1 second
      5000,      // 5 seconds
      30000,     // 30 seconds
      60000,     // 1 minute
      120000     // 2 minutes
    ];
    this.maxQueueSize = 1000; // Prevent memory issues
  }

  /**
   * Start the webhook processor
   */
  start() {
    if (this.processInterval) return;

    // Process queue every 2 seconds
    this.processInterval = setInterval(() => {
      this.processQueue();
    }, 2000);

    logger.info('[WEBHOOK] In-memory delivery service started');
  }

  /**
   * Stop the webhook processor
   */
  stop() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
      
      // Log any pending webhooks that will be lost
      if (this.queue.length > 0) {
        logger.warn(`[WEBHOOK] Service stopped with ${this.queue.length} pending webhooks (will be lost)`);
      }
      
      logger.info('[WEBHOOK] Delivery service stopped');
    }
  }

  /**
   * Get queue statistics
   */
  getStats() {
    const pending = this.queue.filter(item => item.status === 'pending').length;
    const processing = this.queue.filter(item => item.status === 'processing').length;
    const retrying = this.queue.filter(item => item.attemptCount > 0).length;
    
    return {
      total: this.queue.length,
      pending,
      processing,
      retrying,
      maxSize: this.maxQueueSize
    };
  }

  /**
   * Queue a webhook for delivery (in-memory)
   */
  queueWebhook(accountId, webhook, payload) {
    // Check queue size limit
    if (this.queue.length >= this.maxQueueSize) {
      logger.error(`[WEBHOOK] Queue full (${this.maxQueueSize}), dropping webhook for ${webhook.url}`);
      return;
    }

    const item = {
      id: crypto.randomUUID(),
      accountId,
      webhookId: webhook.id,
      webhookUrl: webhook.url,
      webhookSecret: webhook.secret || null,
      payload,
      status: 'pending',
      attemptCount: 0,
      nextRetryAt: Date.now(),
      createdAt: Date.now(),
      lastError: null
    };

    this.queue.push(item);
    logger.info(`[WEBHOOK] Queued for ${webhook.url} (queue size: ${this.queue.length})`);
    
    // Try to process immediately if not already processing
    if (!this.isProcessing) {
      setImmediate(() => this.processQueue());
    }
  }

  /**
   * Process pending webhooks from in-memory queue
   */
  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const now = Date.now();
      
      // Get items ready to process (pending and retry time has passed)
      const readyItems = this.queue.filter(item => 
        item.status === 'pending' && item.nextRetryAt <= now
      );

      // Process up to 10 at a time
      const batch = readyItems.slice(0, 10);

      for (const item of batch) {
        await this.processQueueItem(item);
      }

      // Clean up old failed items (older than 10 minutes)
      const cutoff = now - 600000;
      const beforeCount = this.queue.length;
      this.queue = this.queue.filter(item => 
        item.status !== 'failed' || item.createdAt > cutoff
      );
      
      const removed = beforeCount - this.queue.length;
      if (removed > 0) {
        logger.debug(`[WEBHOOK] Cleaned up ${removed} old failed items from queue`);
      }

    } catch (error) {
      logger.error(`[WEBHOOK] Error processing queue: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single queue item
   */
  async processQueueItem(item) {
    // Mark as processing
    item.status = 'processing';
    item.attemptCount++;

    const startTime = Date.now();
    
    try {
      const result = await this.deliverWebhook(
        { url: item.webhookUrl, secret: item.webhookSecret },
        item.payload
      );

      if (result.success) {
        // Success - remove from queue
        this.queue = this.queue.filter(i => i.id !== item.id);
        logger.info(`[WEBHOOK] Delivered successfully to ${item.webhookUrl} (${Date.now() - startTime}ms)`);
      } else {
        // Failed - handle retry
        this.handleDeliveryFailure(item, result.error);
      }
    } catch (error) {
      this.handleDeliveryFailure(item, error.message);
    }
  }

  /**
   * Handle delivery failure with retry logic
   */
  handleDeliveryFailure(item, errorMessage) {
    item.lastError = errorMessage;

    if (item.attemptCount >= this.maxRetries) {
      // Max retries reached - mark as failed (will be cleaned up later)
      item.status = 'failed';
      logger.warn(`[WEBHOOK] Failed after ${item.attemptCount} attempts: ${item.webhookUrl} - ${errorMessage}`);
    } else {
      // Schedule retry with exponential backoff
      const delayIndex = Math.min(item.attemptCount - 1, this.retryDelays.length - 1);
      const delay = this.retryDelays[delayIndex];
      item.nextRetryAt = Date.now() + delay;
      item.status = 'pending';
      
      logger.info(`[WEBHOOK] Retry ${item.attemptCount}/${this.maxRetries} scheduled in ${delay/1000}s for ${item.webhookUrl}`);
    }
  }

  /**
   * Deliver webhook immediately
   */
  async deliverWebhook(webhook, payload) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsApp-Multi-Automation/4.0'
      };

      // Add signature if secret is provided
      if (webhook.secret) {
        const signature = this.generateSignature(payload, webhook.secret);
        headers['X-Webhook-Signature'] = signature;
        headers['X-Webhook-Signature-256'] = signature;
      }

      const response = await axios.post(webhook.url, payload, {
        headers,
        timeout: 15000, // 15 second timeout
        validateStatus: () => true // Don't throw on any status — we handle all codes
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true, statusCode: response.status };
      } else if (response.status === 410) {
        // 410 Gone — endpoint permanently removed, don't retry
        return { success: false, statusCode: response.status, error: 'HTTP 410 Gone — endpoint removed' };
      } else {
        // All other errors (4xx, 5xx) — mark as failed so retry logic kicks in
        return { 
          success: false, 
          statusCode: response.status, 
          error: `HTTP ${response.status}` 
        };
      }
    } catch (error) {
      const errorMsg = error.code === 'ECONNABORTED' ? 'Timeout' : error.message;
      return { 
        success: false, 
        error: errorMsg
      };
    }
  }

  /**
   * Generate HMAC signature for webhook payload
   */
  generateSignature(payload, secret) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return 'sha256=' + crypto.createHmac('sha256', secret).update(data).digest('hex');
  }

  /**
   * Dispatch webhook to all active webhooks for an account
   */
  async dispatch(accountId, event, data) {
    try {
      logger.info(`[WEBHOOK] Dispatching event '${event}' for account ${accountId}`);
      
      const webhooks = await db.getActiveWebhooks(accountId);
      
      if (!webhooks || webhooks.length === 0) {
        logger.info(`[WEBHOOK] No active webhooks for account ${accountId}`);
        return;
      }
      
      logger.info(`[WEBHOOK] Found ${webhooks.length} active webhook(s)`);

      for (const webhook of webhooks) {
        // Check if webhook is subscribed to this event type
        const events = webhook.events || ['message'];
        
        if (!events.includes(event) && !events.includes('*')) {
          logger.debug(`[WEBHOOK] ${webhook.url} not subscribed to '${event}'`);
          continue;
        }

        const payload = {
          event,
          timestamp: new Date().toISOString(),
          account_id: accountId,
          data
        };

        this.queueWebhook(accountId, webhook, payload);
      }
    } catch (error) {
      logger.error(`[WEBHOOK] Dispatch failed: ${error.message}`);
    }
  }
}

module.exports = new WebhookDeliveryService();
