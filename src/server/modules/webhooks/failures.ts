/** Error handling and the dead letter queue for webhooks. Port of `core/infrastructure/fastapi/webhooks.py`. */
import type { Db } from '../../db/client';
import { failedWebhooks } from '../../db/schema';
import { getLogger } from '../../lib/logging';
import { alertOwners, esc, tags } from '../messages/admin-messages';
import type { Json } from '../payments/types';
import { errorMessage } from '../payments/utils';

const logger = getLogger('webhooks');

export type WebhookErrorType = 'infrastructure' | 'permanent' | 'transient' | 'unknown';

/** Store a failed webhook in the dead letter queue. Never throws. */
export async function storeFailedWebhook(
  db: Db,
  provider: string,
  payload: Json,
  error: string,
  errorType: WebhookErrorType,
): Promise<void> {
  try {
    await db.insert(failedWebhooks).values({ provider, payload, errorMessage: error, errorType });
    logger.info(`Stored failed webhook in DLQ: ${provider} - ${errorType}`);
  } catch (err) {
    logger.error({ err }, `Failed to store failed webhook in DLQ: ${errorMessage(err)}`);
  }
}

/** Alert, don't just log: a failed webhook in the logs alone goes unnoticed. */
export async function alertWebhookFailure(
  payload: Json,
  error: unknown,
  severity: 'critical' | 'error',
): Promise<void> {
  const object = ('object' in payload ? payload.object : {}) as Json;
  const paymentId = payload.payment_id || object.id;
  const alertMessage = { alert_type: 'webhook_failure', severity, payment_id: paymentId, error: errorMessage(error) };

  if (severity === 'critical') logger.fatal(`CRITICAL webhook failure: ${JSON.stringify(alertMessage)}`);
  else logger.error(`Webhook failure: ${JSON.stringify(alertMessage)}`);

  const event = payload.event || payload.type || '?';
  await alertOwners(
    `🚨 <b>Payment webhook failed</b> · ${esc(event)}\n` +
      `<code>${esc(paymentId || '—')}</code>: ${esc(errorMessage(error).slice(0, 300))}\n` +
      '<i>Stored in failed_webhooks; the provider may retry.</i>\n' +
      `${tags('webhook', severity === 'critical' ? 'critical' : 'error')}`,
  );
}
