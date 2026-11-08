/** Port of `tests/unit/webhooks/`. */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { TelegramWebhookValidator, YooKassaWebhookValidator } from './validators';

const sign = (secret: string, canonical: string) => createHmac('sha256', secret).update(canonical).digest('hex');

function statusOf(fn: () => unknown): { status: number; detail: unknown } {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return { status: e.status, detail: e.detail };
    throw e;
  }
  throw new Error('did not throw');
}

describe('TelegramWebhookValidator', () => {
  it('accepts the secret', () => {
    expect(new TelegramWebhookValidator('test_secret_token_123').validateSecret('test_secret_token_123')).toBe(true);
  });

  it('rejects a wrong secret with a 401', () => {
    const validator = new TelegramWebhookValidator('correct_token');

    expect(statusOf(() => validator.validateSecret('wrong_token'))).toEqual({
      status: 401,
      detail: 'Invalid webhook secret token',
    });
  });

  it('rejects a secret of another length the same way', () => {
    const validator = new TelegramWebhookValidator('correct_secret_token');

    expect(statusOf(() => validator.validateSecret('short')).status).toBe(401);
  });

  it('a missing header is a 401', () => {
    const validator = new TelegramWebhookValidator('test_secret_token_456');

    expect(statusOf(() => validator.validateSecret(null))).toEqual({
      status: 401,
      detail: 'Missing X-Telegram-Bot-Api-Secret-Token header',
    });
  });

  it('an empty header is a 401', () => {
    expect(statusOf(() => new TelegramWebhookValidator('real_secret').validateSecret('')).status).toBe(401);
  });
});

describe('YooKassaWebhookValidator', () => {
  const payload = { type: 'payment.succeeded', object: { id: 'pay_123', status: 'succeeded' } };

  it('accepts a valid signature', () => {
    const signature = sign('test_secret_123', 'payment.succeeded&pay_123&succeeded');

    expect(new YooKassaWebhookValidator('test_secret_123').validateSignature(payload, `Bearer ${signature}`)).toBe(
      true,
    );
  });

  it('rejects an invalid signature with a 401', () => {
    const validator = new YooKassaWebhookValidator('test_secret_456');

    expect(statusOf(() => validator.validateSignature(payload, 'Bearer wrong_signature_here'))).toEqual({
      status: 401,
      detail: 'Invalid webhook signature',
    });
  });

  it('a missing header is a 401', () => {
    const validator = new YooKassaWebhookValidator('test_secret_789');

    expect(statusOf(() => validator.validateSignature(payload, null))).toEqual({
      status: 401,
      detail: 'Missing Authorization header',
    });
  });

  it('an empty bearer is a 401', () => {
    const validator = new YooKassaWebhookValidator('test_secret_abc');

    expect(statusOf(() => validator.validateSignature(payload, 'Bearer ')).detail).toBe('Invalid webhook signature');
  });

  it('a signature over another field order is rejected', () => {
    const signature = sign('test_secret_def', 'pay_123&payment.succeeded&succeeded');
    const validator = new YooKassaWebhookValidator('test_secret_def');

    expect(statusOf(() => validator.validateSignature(payload, `Bearer ${signature}`)).status).toBe(401);
  });

  it('a malformed payload is rejected', () => {
    const validator = new YooKassaWebhookValidator('test_secret_ghi');

    expect(() => validator.validateSignature({ type: 'payment.succeeded', object: null }, 'Bearer x')).toThrow();
    expect(() => validator.validateSignature([], 'Bearer x')).toThrow();
  });

  it('missing fields count as empty', () => {
    const signature = sign('s', '&&');

    expect(new YooKassaWebhookValidator('s').validateSignature({}, `Bearer ${signature}`)).toBe(true);
  });
});
