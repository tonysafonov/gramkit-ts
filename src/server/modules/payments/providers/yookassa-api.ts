/**
 * YooKassa's REST API, what the Python app reached through the `yookassa` SDK: same requests, same retry on a 202, an
 * exception for anything but a 200. Stateless, one module per process.
 */
import { randomUUID } from 'node:crypto';
import { settings } from '../../../config';
import type { Json } from '../types';

const API_ROOT = 'https://api.yookassa.ru/v3';

/** The SDK's retry: a 202 means "still processing", ask again with the same Idempotence-Key. */
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1800;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class YooKassaApiError extends Error {
  override readonly name = 'YooKassaApiError';

  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`YooKassa API error ${status}: ${JSON.stringify(body)}`);
  }
}

export interface YooKassaPaymentMethod {
  id?: string;
  type?: string;
}

export interface YooKassaCancellationDetails {
  party?: string;
  reason?: string;
}

export interface YooKassaPayment {
  id: string;
  status: string;
  metadata?: Json | null;
  confirmation?: { confirmation_token?: string; confirmation_url?: string } | null;
  payment_method?: YooKassaPaymentMethod | null;
  cancellation_details?: YooKassaCancellationDetails | null;
}

export interface YooKassaRefund {
  id: string;
  status: string;
  payment_id: string;
  amount: { value: string; currency: string };
  description?: string | null;
}

function authorization(): string {
  const { shopId, secretKey } = settings.payment;
  if (!shopId || !secretKey) throw new Error('YooKassa credentials are not configured');
  return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: Json, idempotenceKey?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: authorization() };
  if (idempotenceKey) headers['idempotence-key'] = idempotenceKey;
  const init: RequestInit = { method, headers, body: body ? JSON.stringify(body) : undefined };

  let response = await fetch(`${API_ROOT}${path}`, init);
  for (let retry = 1; method === 'POST' && response.status === 202 && retry <= MAX_RETRIES; retry++) {
    if (retry > 1) await sleep(RETRY_BACKOFF_MS * 2 ** (retry - 1));
    response = await fetch(`${API_ROOT}${path}`, init);
  }

  const data = await readBody(response);
  if (response.status !== 200) throw new YooKassaApiError(response.status, data);
  return data as T;
}

function requireId(id: unknown): string {
  if (typeof id !== 'string' || !id) throw new Error('Invalid payment_id value');
  return encodeURIComponent(id);
}

export const yookassaPayments = {
  /** The SDK picks a random key when there is none. */
  create: (request: Json, idempotencyKey?: string | null): Promise<YooKassaPayment> =>
    call('POST', '/payments', request, idempotencyKey || randomUUID()),

  findOne: async (paymentId: unknown): Promise<YooKassaPayment> => call('GET', `/payments/${requireId(paymentId)}`),
};

export const yookassaRefunds = {
  findOne: async (refundId: unknown): Promise<YooKassaRefund> => call('GET', `/refunds/${requireId(refundId)}`),
};

export interface WebhookNotification {
  event: string;
  object: Json;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The SDK's `WebhookNotificationFactory.create`: throws on anything that isn't a notification. */
export function parseWebhookNotification(data: unknown): WebhookNotification {
  if (!isRecord(data)) throw new TypeError('Parameter "data" should be "dict"');
  if (!('type' in data && 'event' in data))
    throw new Error('Parameter "data" should contain "type" and "event" fields');
  if (data.type !== 'notification') throw new TypeError('Parameter "data" should contain "type" field');
  if ('object' in data) {
    if (!data.object || (isRecord(data.object) && Object.keys(data.object).length === 0)) {
      throw new Error('Parameter object is empty');
    }
    if (!isRecord(data.object)) throw new TypeError('Invalid object type');
  }
  // An absent `object` passes the factory; reading it blows up later, as it does in Python.
  return { event: String(data.event), object: data.object as Json };
}
