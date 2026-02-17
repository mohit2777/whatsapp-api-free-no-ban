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
    this.activeDeliveries = 0; // Track concurrent deliveries
    this.maxConcurrent = 15;   // Max concurrent HTTP requests
    this.deliveryStats = { sent: 0, failed: 0, retries: 0 }; // Lifetime stats
  }

  /**
   * Start the webhook processor
   */
  start() {
    if (this.processInterval) return;

    // Process retries and cleanup every 3 seconds (new items are processed immediately)
    this.processInterval = setInterval(() => {
      this.processRetries();
    }, 3000);

    logger.info('[WEBHOOK] Delivery service started (immediate mode)');
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
    const failed = this.queue.filter(item => item.status === 'failed').length;
    
    return {
      total: this.queue.length,
      pending,
      processing,
      failed,
      retrying: this.queue.filter(item => item.attemptCount > 0 && item.status === 'pending').length,
      activeDeliveries: this.activeDeliveries,
      maxSize: this.maxQueueSize,
      lifetime: { ...this.deliveryStats }
    };
  }

  /**
   * Queue a webhook for delivery and immediately attempt delivery
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
    
    // IMMEDIATE DELIVERY — don't wait for the timer, fire delivery right now
    // This ensures new webhooks are processed without any delay, regardless
    // of what other items are doing in the queue.
    this.deliverItem(item);
  }

  /**
   * Fire-and-forget delivery of a single item with concurrency limiting.
   * This runs independently — no global lock, no blocking other items.
   */
  deliverItem(item) {
    // Concurrency check: if too many HTTP requests in flight, let the timer handle it
    if (this.activeDeliveries >= this.maxConcurrent) {
      logger.debug(`[WEBHOOK] Concurrency limit reached (${this.activeDeliveries}/${this.maxConcurrent}), deferring ${item.webhookUrl}`);
      return;
    }

    // Fire-and-forget — errors are handled inside processQueueItem
    this.processQueueItem(item).catch(err => {
      logger.error(`[WEBHOOK] Unexpected delivery error: ${err.message}`);
    });
  }

  /**
   * Process retries, recover stuck items, and clean up failures.
   * Runs on a timer as a safety net — primary delivery is immediate via deliverItem().
   */
  async processRetries() {
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
        }
      }
      
      // Pick up retry items that are ready (nextRetryAt has passed)
      const retryItems = this.queue.filter(item => 
        item.status === 'pending' && item.attemptCount > 0 && item.nextRetryAt <= now
      );

      // Also pick up any items still pending with attemptCount === 0 (missed by immediate delivery)
      const missedItems = this.queue.filter(item =>
        item.status === 'pending' && item.attemptCount === 0 && item.nextRetryAt <= now
      );

      const readyItems = [...retryItems, ...missedItems];

      for (const item of readyItems) {
        this.deliverItem(item);
      }

      // Clean up old failed items (older than 10 minutes)
      const cutoff = now - 600000;
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].status === 'failed' && this.queue[i].createdAt <= cutoff) {
          this.queue.splice(i, 1);
        }
      }

    } catch (error) {
      logger.error(`[WEBHOOK] Error in retry processor: ${error.message}`);
    }
  }

  /**
   * Process a single queue item.
   * Guarded: if another call already started processing this item, this is a no-op.
   */
  async processQueueItem(item) {
    // Guard: prevent double processing — only process items that are still pending
    if (item.status !== 'pending') return;

    // Mark as processing (atomic in single-threaded Node.js — no race between check & set)
    item.status = 'processing';
    item.processingStartedAt = Date.now();
    item.attemptCount++;
    this.activeDeliveries++;

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
        this.deliveryStats.sent++;
        logger.info(`[WEBHOOK] ✓ Delivered to ${item.webhookUrl} (${Date.now() - startTime}ms, attempt ${item.attemptCount})`);
      } else {
        // Failed - handle retry
        this.handleDeliveryFailure(item, result.error);
      }
    } catch (error) {
      // Always reset status on unexpected error so item isn't stuck in 'processing'
      this.handleDeliveryFailure(item, error.message || 'Unknown processing error');
    } finally {
      item.processingStartedAt = null;
      this.activeDeliveries = Math.max(0, this.activeDeliveries - 1);
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
      this.deliveryStats.failed++;
      logger.warn(`[WEBHOOK] ✗ Failed after ${item.attemptCount} attempts: ${item.webhookUrl} - ${errorMessage}`);
    } else {
      // Schedule retry with exponential backoff
      const delayIndex = Math.min(item.attemptCount - 1, this.retryDelays.length - 1);
      const delay = this.retryDelays[delayIndex];
      item.nextRetryAt = Date.now() + delay;
      item.status = 'pending';
      this.deliveryStats.retries++;
      
      logger.info(`[WEBHOOK] Retry ${item.attemptCount}/${this.maxRetries} in ${delay/1000}s for ${item.webhookUrl} (${errorMessage})`);
    }
  }

  /**
   * Deliver webhook immediately via HTTP POST
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
        timeout: 10000, // 10 second timeout (reduced from 15 to prevent queue backup)
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
      const errorMsg = error.code === 'ECONNABORTED' ? 'Timeout (10s)' 
        : error.code === 'ECONNREFUSED' ? 'Connection refused'
        : error.code === 'ENOTFOUND' ? 'DNS lookup failed'
        : error.code === 'ETIMEDOUT' ? 'Connection timed out'
        : error.message;
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
          // Log at INFO so users can actually see why a webhook was skipped
          logger.info(`[WEBHOOK] Skipped ${webhook.url} — not subscribed to '${event}' (subscribed: [${events.join(', ')}])`);
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

    if (queued > 0) {
      logger.info(`[WEBHOOK] Queued ${queued}/${webhooks.length} webhook(s) for event '${event}'`);
    } else if (webhooks.length > 0) {
      logger.warn(`[WEBHOOK] No webhooks matched event '${event}' — check event subscriptions in dashboard`);
    }
  }
}

module.exports = new WebhookDeliveryService();
