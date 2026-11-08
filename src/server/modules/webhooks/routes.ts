import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getServices } from '../../auth/context';
import { PaymentProvider } from '../../db/schema';
import type { Env, ServicesEnv } from '../../env';
import { AppError, NotFoundError } from '../../lib/errors';
import { isInfrastructureError } from '../../lib/infra-errors';
import { getLogger } from '../../lib/logging';
import { type Json, PaymentValueError } from '../payments/types';
import { errorMessage } from '../payments/utils';
import { alertWebhookFailure, storeFailedWebhook } from './failures';
import { TelegramWebhookValidator, YooKassaWebhookValidator } from './validators';

const logger = getLogger('webhooks');

const PERMANENT_ERRORS = ['not found', 'invalid product', 'invalid payment'];

/**
 * One provider's webhook. Answers:
 * - 200: processed;
 * - 400: invalid JSON, permanent business errors;
 * - 500: transient business errors, unknown errors;
 * - 503: infrastructure errors (DB, Redis): the provider should retry.
 *
 * Failures are stored in the dead letter queue. Error answers are returned, not thrown, so the DLQ row commits, and with
 * it whatever the callback wrote before failing. A failed signature check lands in the "unknown" branch: the Python
 * router re-raises it inside its own try, so it answers 500, not the validator's 401.
 */
async function handleWebhook(
  c: Context<ServicesEnv>,
  provider: PaymentProvider,
  label: string,
  verify: (payload: Json) => Promise<void>,
): Promise<Response> {
  const { db } = c.get('repos');
  let payload: Json | undefined;
  try {
    try {
      payload = await c.req.json<Json>();
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      const message = `Invalid JSON payload: ${e.message}`;
      logger.error(message);
      await alertWebhookFailure({}, e, 'error');
      return c.body(message, 400);
    }

    logger.info(`Received ${label} webhook payload: ${JSON.stringify(payload)}`);

    await verify(payload);

    await c.get('services').payments.processCallback(payload, provider);

    logger.info(`${label} webhook processed successfully`);
    return c.body(null, 200);
  } catch (err) {
    const body = payload ?? {};
    const message = errorMessage(err);

    if (isInfrastructureError(err)) {
      // The provider should retry
      logger.error({ err }, `Infrastructure error processing ${label} webhook: ${message}`);
      await storeFailedWebhook(db, provider, body, message, 'infrastructure');
      await alertWebhookFailure(body, err, 'critical');
      return c.body('Service temporarily unavailable', 503);
    }

    if (err instanceof PaymentValueError) {
      if (PERMANENT_ERRORS.some((keyword) => message.toLowerCase().includes(keyword))) {
        logger.error({ err }, `Permanent error in ${label} webhook: ${message}`);
        await storeFailedWebhook(db, provider, body, message, 'permanent');
        await alertWebhookFailure(body, err, 'error');
        return c.body(message, 400);
      }

      logger.error({ err }, `Transient error in ${label} webhook: ${message}`);
      await storeFailedWebhook(db, provider, body, message, 'transient');
      await alertWebhookFailure(body, err, 'error');
      return c.body('Internal server error', 500);
    }

    logger.error({ err }, `Unknown error processing ${label} webhook: ${message}`);
    await storeFailedWebhook(db, provider, body, message, 'unknown');
    await alertWebhookFailure(body, err, 'critical');
    return c.body('Internal server error', 500);
  }
}

/** YooKassa's payment confirmations. */
export const yookassaRoutes = new Hono<Env>().post('/webhook', getServices, (c) =>
  handleWebhook(c, PaymentProvider.YOOKASSA, 'YooKassa', async (payload) => {
    const secret = c.get('state').yookassaWebhookSecret;
    if (!secret) return;
    try {
      new YooKassaWebhookValidator(secret).validateSignature(payload, c.req.header('Authorization'));
      logger.info('YooKassa webhook signature validated');
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      logger.warn(`Invalid YooKassa webhook signature: ${e.message}`);
      await alertWebhookFailure(payload, new Error(`Invalid signature: ${e.message}`), 'critical');
      throw e;
    }
  }),
);

/**
 * The Stars webhook answers only when a secret is configured (`createApi({ telegramWebhookSecret })`); otherwise it is a
 * 404, before any transaction opens. Python checks the secret only `if telegram_secret:`, and no app sets one, so its
 * route takes any body: the Stars provider trusts `successful_payment` as it arrives (there is no re-fetch, unlike
 * YooKassa), so a forged one would grant a product, or a renewal per request, without paying.
 */
const requireTelegramSecret = createMiddleware<Env>(async (c, next) => {
  if (!c.get('state').telegramWebhookSecret) throw new NotFoundError();
  await next();
});

/**
 * Telegram Stars confirmations from a web interface. DORMANT, kept on purpose: the live path is the bot (see
 * `modules/payments/bot.ts`), and nothing POSTs here. It routes the same payload contract through the same
 * `processCallback`, so a web Stars flow could light it up without re-implementing payment finalization. Off (404)
 * until a secret is configured.
 */
export const telegramStarsRoutes = new Hono<Env>().post('/webhook', requireTelegramSecret, getServices, (c) =>
  handleWebhook(c, PaymentProvider.TELEGRAM_STARS, 'Telegram Stars', async (payload) => {
    const secret = c.get('state').telegramWebhookSecret ?? '';
    try {
      new TelegramWebhookValidator(secret).validateSecret(c.req.header('X-Telegram-Bot-Api-Secret-Token'));
      logger.info('Telegram webhook secret validated');
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      logger.warn(`Invalid Telegram webhook secret: ${e.message}`);
      await alertWebhookFailure(payload, new Error(`Invalid secret: ${e.message}`), 'critical');
      throw e;
    }
  }),
);
