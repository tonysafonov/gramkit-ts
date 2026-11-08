/** Webhook signature checks. Port of `core/infrastructure/webhooks/`. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '../../lib/errors';

/** Constant-time comparison, so a guess learns nothing from timing. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class YooKassaWebhookValidator {
  constructor(private readonly apiSecret: string) {}

  /**
   * `Authorization: Bearer <signature>`, the signature being HMAC-SHA256 of `{type}&{object id}&{object status}`.
   * Throws a 401 when it is missing or wrong, a `TypeError` for a body that isn't a notification.
   */
  validateSignature(payload: unknown, signatureHeader: string | null | undefined): true {
    if (!signatureHeader) throw new UnauthorizedError('Missing Authorization header');

    const signature = signatureHeader.replaceAll('Bearer ', '').trim();

    if (!isRecord(payload)) throw new TypeError('Invalid webhook payload: not an object');
    const object = 'object' in payload ? payload.object : {};
    if (!isRecord(object)) throw new TypeError('Invalid webhook payload: no object');

    const canonical = `${payload.type ?? ''}&${object.id ?? ''}&${object.status ?? ''}`;
    const expected = createHmac('sha256', this.apiSecret).update(canonical).digest('hex');

    if (!safeEqual(signature, expected)) throw new UnauthorizedError('Invalid webhook signature');
    return true;
  }
}

export class TelegramWebhookValidator {
  constructor(private readonly secretToken: string) {}

  /** The `X-Telegram-Bot-Api-Secret-Token` header: the secret set when the webhook was registered. */
  validateSecret(headerValue: string | null | undefined): true {
    if (!headerValue) throw new UnauthorizedError('Missing X-Telegram-Bot-Api-Secret-Token header');
    if (!safeEqual(headerValue, this.secretToken)) throw new UnauthorizedError('Invalid webhook secret token');
    return true;
  }
}
