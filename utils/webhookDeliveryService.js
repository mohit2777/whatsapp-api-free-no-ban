/**
 * Webhook Delivery Service
 * Handles reliable webhook delivery with retries and dead-letter queue
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('./logger');
const { db } = require('../config/database');

class WebhookDeliveryService {
  constructor() {
    this.isProcessing = false;
    this.processInterval = null;
    this.retryDelays = [
      1000,      // 1 second
      5000,      // 5 seconds
      30000,     // 30 seconds
      120000,    // 2 minutes
      300000     // 5 minutes
    ];
  }

  /**
   * Start the webhook processor
   */
  start() {
    if (this.processInterval) return;

    this.processInterval = setInterval(() => {
      this.processQueue();
    }, 5000); // Process every 5 seconds

    logger.info('Webhook delivery service started');
  }

  /**
   * Stop the webhook processor
   */
  stop() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
      logger.info('Webhook delivery service stopped');
    }
  }

  /**
   * Queue a webhook for delivery
   */
  async queueWebhook(accountId, webhook, payload) {
    try {
      await db.addToWebhookQueue({
        account_id: accountId,
        webhook_id: webhook.id,
        webhook_url: webhook.url,
        webhook_secret: webhook.secret || null,
        payload,
        status: 'pending',
        attempt_count: 0,
        max_retries: 5,
        next_retry_at: new Date().toISOString()
      });

      logger.info(`Webhook queued successfully for ${webhook.url}`);
    } catch (error) {
      // If queue table doesn't exist or any error, deliver directly
      logger.warn(`Queue failed (${error.message}), delivering webhook directly to ${webhook.url}`);
      
      // Deliver directly in background
      this.deliverWebhook(webhook, payload).then(result => {
        if (result.success) {
          logger.info(`Direct webhook delivery successful: ${webhook.url}`);
        } else {
          logger.error(`Direct webhook delivery failed: ${webhook.url} - ${result.error}`);
        }
      }).catch(err => {
        logger.error(`Direct webhook delivery error: ${err.message}`);
      });
    }
  }

  /**
   * Process pending webhooks from queue
   */
  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const pending = await db.getPendingWebhooks(10);

      for (const item of pending) {
        await this.processQueueItem(item);
      }
    } catch (error) {
      if (error.name !== 'MissingWebhookQueueTableError') {
        logger.error('Error processing webhook queue:', error.message);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single queue item
   */
  async processQueueItem(item) {
    try {
      // Mark as processing
      await db.updateWebhookQueueItem(item.id, {
        status: 'processing',
        updated_at: new Date().toISOString()
      });

      const startTime = Date.now();
      const result = await this.deliverWebhook(
        { url: item.webhook_url, secret: item.webhook_secret },
        item.payload
      );
      const processingTime = Date.now() - startTime;

      if (result.success) {
        await db.updateWebhookQueueItem(item.id, {
          status: 'success',
          processing_time_ms: processingTime,
          last_response_code: result.statusCode,
          updated_at: new Date().toISOString()
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      await this.handleDeliveryFailure(item, error.message);
    }
  }

  /**
   * Handle delivery failure with retry logic
   */
  async handleDeliveryFailure(item, errorMessage) {
    const newAttemptCount = item.attempt_count + 1;

    if (newAttemptCount >= item.max_retries) {
      // Move to dead letter
      await db.updateWebhookQueueItem(item.id, {
        status: 'dead_letter',
        attempt_count: newAttemptCount,
        last_error: errorMessage,
        updated_at: new Date().toISOString()
      });
      
      logger.warn(`Webhook moved to dead letter after ${newAttemptCount} attempts: ${item.webhook_url}`);
    } else {
      // Schedule retry
      const delay = this.retryDelays[Math.min(newAttemptCount - 1, this.retryDelays.length - 1)];
      const nextRetry = new Date(Date.now() + delay);

      await db.updateWebhookQueueItem(item.id, {
        status: 'pending',
        attempt_count: newAttemptCount,
        next_retry_at: nextRetry.toISOString(),
        last_error: errorMessage,
        updated_at: new Date().toISOString()
      });

      logger.debug(`Webhook retry scheduled for ${nextRetry.toISOString()}: ${item.webhook_url}`);
    }
  }

  /**
   * Deliver webhook immediately
   */
  async deliverWebhook(webhook, payload) {
    try {
      logger.info(`Delivering webhook to ${webhook.url}`);
      
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

      logger.debug(`Webhook payload: ${JSON.stringify(payload).substring(0, 200)}...`);

      const response = await axios.post(webhook.url, payload, {
        headers,
        timeout: 30000, // Increased timeout to 30 seconds
        validateStatus: (status) => status < 500
      });

      logger.info(`Webhook response from ${webhook.url}: ${response.status}`);

      if (response.status >= 200 && response.status < 300) {
        logger.info(`Webhook delivered successfully: ${webhook.url}`);
        return { success: true, statusCode: response.status };
      } else {
        logger.warn(`Webhook returned non-success status: ${response.status}`);
        return { 
          success: false, 
          statusCode: response.status, 
          error: `HTTP ${response.status}` 
        };
      }
    } catch (error) {
      logger.error(`Webhook delivery failed to ${webhook.url}: ${error.message}`);
      return { 
        success: false, 
        error: error.message 
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
      logger.info(`Looking up webhooks for account ${accountId}, event: ${event}`);
      const webhooks = await db.getActiveWebhooks(accountId);
      logger.info(`Found ${webhooks.length} active webhooks for account ${accountId}`);

      if (webhooks.length === 0) {
        logger.warn(`No active webhooks found for account ${accountId}`);
        return;
      }

      for (const webhook of webhooks) {
        // Check if webhook is subscribed to this event type
        const events = webhook.events || ['message'];
        if (!events.includes(event) && !events.includes('*')) {
          logger.debug(`Webhook ${webhook.url} not subscribed to event ${event}`);
          continue;
        }

        const payload = {
          event,
          timestamp: new Date().toISOString(),
          account_id: accountId,
          data
        };

        logger.info(`Queueing webhook to ${webhook.url} for event ${event}`);
        await this.queueWebhook(accountId, webhook, payload);
      }
    } catch (error) {
      logger.error(`Failed to dispatch webhooks for account ${accountId}:`, error.message);
    }
  }
}

module.exports = new WebhookDeliveryService();
