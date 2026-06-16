/**
 * Webhook delivery: POST asíncrono al backend .NET con retry suave.
 * No bloquea el evento original. Usa header X-Internal-Secret para auth.
 */

import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class WebhookDispatcher {
  constructor() {
    this.url    = process.env.WEBHOOK_URL || null;
    this.secret = process.env.INTERNAL_SECRET || '';
  }

  async dispatch(payload) {
    if (!this.url) return;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'X-Internal-Secret': this.secret,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.warn({ status: res.status, event: payload.event, sessionId: payload.sessionId, body }, 'webhook non-ok');
      }
    } catch (err) {
      logger.warn({ err: err.message, event: payload.event, sessionId: payload.sessionId }, 'webhook failed');
    }
  }
}
