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
    this.processingTimeout = 30000; // 30s max for an item to stay in 'processing'
    this.concurrency = 10; // Deliver up to 10 webhooks in parallel
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
      // Drop oldest failed items to make room before giving up
      const failedIdx = this.queue.findIndex(i => i.status === 'failed');
      if (failedIdx !== -1) {
        this.queue.splice(failedIdx, 1);
        logger.warn(`[WEBHOOK] Queue full, dropped oldest failed item to make room`);
      } else {
        logger.error(`[WEBHOOK] Queue full (${this.maxQueueSize}), dropping webhook for ${webhook.url}`);
        return;
      }
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
      lastError: null,
      processingStartedAt: null
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

      // === RECOVERY: Reset items stuck in 'processing' for too long ===
      for (const item of this.queue) {
        if (
          item.status === 'processing' &&
          item.processingStartedAt &&
          now - item.processingStartedAt > this.processingTimeout
        ) {
          logger.warn(`[WEBHOOK] Recovering stuck item for ${item.webhookUrl} (was processing for ${Math.round((now - item.processingStartedAt) / 1000)}s)`);
          item.status = 'pending';
          item.processingStartedAt = null;
          // Don't increment attemptCount here — it was already incremented when it entered processing
        }
      }
      
      // Get items ready to process (pending and retry time has passed)
      const readyItems = this.queue.filter(item => 
        item.status === 'pending' && item.nextRetryAt <= now
      );

      // Process up to `concurrency` items in parallel
      const batch = readyItems.slice(0, this.concurrency);

      if (batch.length > 0) {
        // Deliver all webhooks in parallel so one slow endpoint doesn't block others
        await Promise.allSettled(
          batch.map(item => this.processQueueItem(item))
        );
      }

      // Clean up old failed items (older than 10 minutes) using splice to avoid array reassignment
      const cutoff = now - 600000;
      let removed = 0;
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].status === 'failed' && this.queue[i].createdAt <= cutoff) {
          this.queue.splice(i, 1);
          removed++;
        }
      }
      
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
    item.processingStartedAt = Date.now();
    item.attemptCount++;

    const startTime = Date.now();
    
    try {
      const result = await this.deliverWebhook(
        { url: item.webhookUrl, secret: item.webhookSecret },
        item.payload
      );

      if (result.success) {
        // Success - remove from queue using splice (safe, no array reassignment)
        const idx = this.queue.indexOf(item);
        if (idx !== -1) this.queue.splice(idx, 1);
        logger.info(`[WEBHOOK] Delivered successfully to ${item.webhookUrl} (${Date.now() - startTime}ms)`);
      } else {
        // Failed - handle retry
        this.handleDeliveryFailure(item, result.error);
      }
    } catch (error) {
      // Always reset status on unexpected error so item isn't stuck in 'processing'
      this.handleDeliveryFailure(item, error.message || 'Unknown processing error');
    } finally {
      item.processingStartedAt = null;
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
   * Normalize the events field from the database.
   * Handles TEXT[], JSON string, null/undefined, or already-an-array.
   */
  normalizeEvents(events) {
    if (!events) return ['message'];
    if (Array.isArray(events)) return events;
    if (typeof events === 'string') {
      try {
        const parsed = JSON.parse(events);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Could be a single event name like 'message'
        return [events];
      }
    }
    return ['message'];
  }

  /**
   * Dispatch webhook to all active webhooks for an account
   */
  async dispatch(accountId, event, data) {
    let webhooks;

    // Retry fetching webhooks from DB up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        webhooks = await db.getActiveWebhooks(accountId);
        break; // success
      } catch (error) {
        logger.error(`[WEBHOOK] Failed to fetch webhooks (attempt ${attempt}/3): ${error.message}`);
        if (attempt === 3) {
          logger.error(`[WEBHOOK] Giving up fetching webhooks for account ${accountId} after 3 attempts`);
          return;
        }
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }

    if (!webhooks || webhooks.length === 0) {
      logger.info(`[WEBHOOK] No active webhooks for account ${accountId}`);
      return;
    }

    logger.info(`[WEBHOOK] Dispatching event '${event}' for account ${accountId} to ${webhooks.length} webhook(s)`);

    let queued = 0;
    for (const webhook of webhooks) {
      try {
        // Check if webhook is subscribed to this event type
        const events = this.normalizeEvents(webhook.events);

        if (!events.includes(event) && !events.includes('*')) {
          logger.debug(`[WEBHOOK] ${webhook.url} not subscribed to '${event}' (subscribed: ${events.join(',')})`);
          continue;
        }

        const payload = {
          event,
          timestamp: new Date().toISOString(),
          account_id: accountId,
          data
        };

        this.queueWebhook(accountId, webhook, payload);
        queued++;
      } catch (webhookError) {
        // Don't let one bad webhook config prevent others from being queued
        logger.error(`[WEBHOOK] Error queuing webhook ${webhook.url}: ${webhookError.message}`);
      }
    }

    logger.info(`[WEBHOOK] Queued ${queued}/${webhooks.length} webhook(s) for event '${event}'`);
  }
}

module.exports = new WebhookDeliveryService();
