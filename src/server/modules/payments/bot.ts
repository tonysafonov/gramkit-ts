/** Telegram Stars payment handlers: pre-checkout, refunds and successful payments arrive as bot updates. */
import { Composer } from 'grammy';
import type { BotContext } from '../../bot/context';
import { PaymentProvider } from '../../db/schema';
import { getLogger } from '../../lib/logging';
import { type Json, PurchaseLimitError } from './types';
import { errorMessage } from './utils';

const logger = getLogger('payments-bot');

/** "payment_{uuid}" -> the id. Throws on what doesn't look like a UUID (a basic check). */
function paymentIdFrom(invoicePayload: string): string {
  const paymentId = invoicePayload.replaceAll('payment_', '');
  if (paymentId.length !== 36 || paymentId.split('-').length - 1 !== 4) {
    throw new Error(`Payment ID doesn't look like a UUID: ${paymentId}`);
  }
  return paymentId;
}

export const paymentsComposer = new Composer<BotContext>();

/**
 * The user confirmed the payment in Telegram, before it is processed: check the payment exists and is theirs, process
 * the callback, then approve or reject the checkout. Payload format: "payment_{uuid}".
 */
paymentsComposer.on('pre_checkout_query', async (ctx) => {
  const query = ctx.preCheckoutQuery;
  const { services } = ctx;
  try {
    logger.info(`Pre-checkout query received: ${query.id} for payload: ${query.invoice_payload}`);

    if (!query.invoice_payload.startsWith('payment_')) {
      logger.error(`Invalid payment payload: ${query.invoice_payload}`);
      await ctx.answerPreCheckoutQuery(false, 'Invalid payment reference');
      return;
    }

    let paymentId: string;
    try {
      paymentId = paymentIdFrom(query.invoice_payload);
    } catch (e) {
      logger.error(`Could not parse payment ID from payload: ${query.invoice_payload} - ${errorMessage(e)}`);
      await ctx.answerPreCheckoutQuery(false, 'Invalid payment reference');
      return;
    }

    const payment = await services.repos.payments.getById(paymentId);
    if (!payment) {
      logger.error(`Payment ${paymentId} not found`);
      await ctx.answerPreCheckoutQuery(false, 'Payment not found');
      return;
    }

    const user = await services.users.getUserById(payment.userId);
    if (!user) {
      logger.error(`User not found for payment ${paymentId}`);
      await ctx.answerPreCheckoutQuery(false, 'User not found');
      return;
    }

    if (user.telegramId !== query.from.id) {
      logger.error(`Payment ${paymentId} does not belong to user ${query.from.id}`);
      await ctx.answerPreCheckoutQuery(false, 'Unauthorized payment');
      return;
    }

    // The daily cap again, right before the charge: invoices opened ahead and paid later.
    try {
      await services.payments.checkPurchaseAllowed(payment.userId, payment.productId);
    } catch (e) {
      if (!(e instanceof PurchaseLimitError)) throw e;
      const ru = (query.from.language_code ?? '').startsWith('ru');
      await ctx.answerPreCheckoutQuery(
        false,
        ru ? 'На сегодня хватит — завтра снова можно.' : "That's enough for today — try again tomorrow.",
      );
      return;
    }

    const payload: Json = {
      pre_checkout_query: {
        id: query.id,
        from: query.from,
        currency: query.currency,
        total_amount: query.total_amount,
        invoice_payload: query.invoice_payload,
      },
      payload: query.invoice_payload,
    };
    await services.payments.processCallback(payload, PaymentProvider.TELEGRAM_STARS);

    await ctx.answerPreCheckoutQuery(true);
    logger.info(`Pre-checkout query ${query.id} approved for payment ${paymentId}`);
  } catch (e) {
    logger.error(`Error handling pre-checkout query ${query.id}: ${errorMessage(e)}`);
    await ctx.answerPreCheckoutQuery(false, 'Payment processing error');
  }
});

/**
 * Telegram reports a refunded Star charge: ours (refundStarPayment from the admin panel, which has already marked the
 * payment REFUNDED, so this is a no-op) or one made on Telegram's side. The payment becomes REFUNDED and the owner is
 * told.
 */
paymentsComposer.on('message:refunded_payment', async (ctx) => {
  const refunded = ctx.message.refunded_payment;
  logger.info(
    `Refunded payment received for user ${ctx.from.id}: ${refunded.invoice_payload}, charge_id=${refunded.telegram_payment_charge_id}`,
  );
  const payload: Json = {
    refunded_payment: {
      currency: refunded.currency,
      total_amount: refunded.total_amount,
      invoice_payload: refunded.invoice_payload,
      telegram_payment_charge_id: refunded.telegram_payment_charge_id,
      provider_payment_charge_id: refunded.provider_payment_charge_id ?? null,
    },
    payload: refunded.invoice_payload,
  };
  try {
    await ctx.services.payments.processCallback(payload, PaymentProvider.TELEGRAM_STARS);
  } catch (err) {
    logger.error(
      { err },
      `Error handling refunded payment ${refunded.telegram_payment_charge_id}: ${errorMessage(err)}`,
    );
  }
});

/**
 * A successful Telegram Stars payment, after Telegram processed it: finalizes the payment and grants what was bought.
 * Telegram's flags go through so the provider can tell an initial charge from an auto-renewal: `is_recurring` is true on
 * EVERY subscription charge, `is_first_recurring` only on the first one. Payload format: "payment_{uuid}".
 */
paymentsComposer.on('message:successful_payment', async (ctx) => {
  const successfulPayment = ctx.message.successful_payment;
  try {
    logger.info(`Successful payment received for user ${ctx.from.id}: ${successfulPayment.invoice_payload}`);
    logger.info(
      `Full successful_payment details: currency=${successfulPayment.currency}, amount=${successfulPayment.total_amount}, charge_id=${successfulPayment.telegram_payment_charge_id}`,
    );

    if (!successfulPayment.invoice_payload.startsWith('payment_')) {
      logger.error(`Invalid payment payload: ${successfulPayment.invoice_payload}`);
      return;
    }

    let paymentId: string;
    try {
      paymentId = paymentIdFrom(successfulPayment.invoice_payload);
    } catch (e) {
      logger.error(
        `Could not parse payment ID from payload: ${successfulPayment.invoice_payload} - ${errorMessage(e)}`,
      );
      return;
    }

    const isRecurring = Boolean(successfulPayment.is_recurring);
    const isFirstRecurring = Boolean(successfulPayment.is_first_recurring);

    const payload: Json = {
      successful_payment: {
        currency: successfulPayment.currency,
        total_amount: successfulPayment.total_amount,
        invoice_payload: successfulPayment.invoice_payload,
        telegram_payment_charge_id: successfulPayment.telegram_payment_charge_id,
        provider_payment_charge_id: successfulPayment.provider_payment_charge_id,
        subscription_expiration_date: successfulPayment.subscription_expiration_date ?? null,
        is_recurring: isRecurring,
        is_first_recurring: isFirstRecurring,
      },
      payload: successfulPayment.invoice_payload,
      from_user: ctx.from,
      is_recurring: isRecurring,
      is_first_recurring: isFirstRecurring,
    };

    await ctx.services.payments.processCallback(payload, PaymentProvider.TELEGRAM_STARS);

    logger.info(`Successful payment processed for payment ${paymentId}`);
  } catch (err) {
    logger.error({ err }, `Error handling successful payment for user ${ctx.from.id}: ${errorMessage(err)}`);
    logger.error(
      `Payment details: ${successfulPayment.invoice_payload}, charge_id: ${successfulPayment.telegram_payment_charge_id}`,
    );
    await ctx.reply(
      "❌ There was an error processing your payment confirmation. Please contact support if your payment was charged but you didn't receive your purchase.",
    );
  }
});
