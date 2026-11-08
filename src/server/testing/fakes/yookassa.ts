import { randomBytes } from 'node:crypto';

const API_ROOT = 'https://api.yookassa.ru/v3';

type Json = Record<string, unknown>;

export interface YooKassaRequest {
  method: string;
  path: string;
  idempotenceKey: string | null;
  body: Json | null;
}

/**
 * YooKassa's REST API behind `fetch`, for code that calls it over HTTP. Only api.yookassa.ru is intercepted.
 *
 * Mirrors what the Python tests drive through the SDK mock:
 * - `status` / `cancellationReason`: the outcome of `POST /payments`;
 * - `networkError`: `POST /payments` fails after being counted (a timeout after the card may have been charged);
 * - `remoteStatus`: what `GET /payments/{id}` says, whatever a webhook body claimed (the re-fetch);
 * - `remoteRefund`: what `GET /refunds/{id}` says, for any id;
 * - `requests`, `lastIdempotenceKey`: for assertions.
 *
 *     const yookassa = new FakeYooKassa().install();
 *     afterAll(() => yookassa.uninstall());
 */
export class FakeYooKassa {
  status = 'pending';
  cancellationReason: string | null = null;
  networkError: Error | null = null;
  remoteStatus: string | null = null;
  remoteRefund: Json | null = null;

  readonly requests: YooKassaRequest[] = [];
  readonly payments = new Map<string, Json>();

  private originalFetch: typeof fetch | null = null;

  get lastIdempotenceKey(): string | null {
    return this.requests.at(-1)?.idempotenceKey ?? null;
  }

  get createCount(): number {
    return this.requests.filter((r) => r.method === 'POST' && r.path === '/payments').length;
  }

  private createPayment(body: Json | null): Json {
    const id = `payment_test_${randomBytes(4).toString('hex')}_${this.createCount}`;
    const payment: Json = {
      id,
      status: this.status,
      amount: body?.amount,
      metadata: body?.metadata ?? {},
      confirmation: {
        type: 'redirect',
        confirmation_url: `https://test.yookassa.ru/checkout/${id}`,
        confirmation_token: `ct_test_${id}`,
      },
      payment_method: { id: `payment_method_test_${id}`, type: 'bank_card', saved: Boolean(body?.save_payment_method) },
      cancellation_details: this.cancellationReason
        ? { party: 'payment_network', reason: this.cancellationReason }
        : undefined,
    };
    this.payments.set(id, payment);
    return payment;
  }

  /** Register a payment as the provider knows it, for `GET /payments/{id}` after a webhook. */
  addPayment(payment: Json & { id: string }): void {
    this.payments.set(payment.id, payment);
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/^\/v3/, '');
    const text = await request.text();
    const body = text ? (JSON.parse(text) as Json) : null;
    const idempotenceKey = request.headers.get('idempotence-key');
    this.requests.push({ method: request.method, path, idempotenceKey, body });

    if (request.method === 'POST' && path === '/payments') {
      if (this.networkError) throw this.networkError;
      return Response.json(this.createPayment(body));
    }
    if (request.method === 'POST' && path === '/refunds') {
      return Response.json({ id: `refund_test_${randomBytes(4).toString('hex')}`, status: 'succeeded', ...body });
    }
    const paymentId = /^\/payments\/([^/]+)$/.exec(path)?.[1];
    if (request.method === 'GET' && paymentId) {
      const payment = this.payments.get(paymentId);
      if (!payment) return Response.json({ type: 'error', code: 'not_found' }, { status: 404 });
      return Response.json(this.remoteStatus ? { ...payment, status: this.remoteStatus } : payment);
    }
    const refundId = /^\/refunds\/([^/]+)$/.exec(path)?.[1];
    if (request.method === 'GET' && refundId) {
      if (!this.remoteRefund) return Response.json({ type: 'error', code: 'not_found' }, { status: 404 });
      return Response.json({ id: refundId, ...this.remoteRefund });
    }
    return Response.json({ type: 'error', code: 'invalid_request' }, { status: 400 });
  }

  install(): this {
    const original = globalThis.fetch;
    this.originalFetch = original;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input as string, init);
      return request.url.startsWith(API_ROOT) ? this.handle(request) : original(input, init);
    }) as typeof fetch;
    return this;
  }

  uninstall(): void {
    if (this.originalFetch) globalThis.fetch = this.originalFetch;
    this.originalFetch = null;
  }
}
