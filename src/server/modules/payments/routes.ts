import { Hono } from 'hono';
import { getUser } from '../../auth/context';
import type { Env } from '../../env';
import { BadRequestError, NotFoundError, TooManyRequestsError } from '../../lib/errors';
import { getLogger } from '../../lib/logging';
import { validate } from '../../lib/validate';
import { HARD_LIMIT, rateLimit, SOFT_LIMIT } from '../../middleware/rate-limit';
import { requireUserId } from '../auth/routes';
import { StartPurchaseRequest, toPaymentStatusResponse, toProductResponse, toStartPurchaseResponse } from './schemas';
import { PaymentValueError, PurchaseLimitError } from './types';
import { parseUuid } from './utils';

const logger = getLogger('payments-routes');

/** `/payments/*`. */
export const paymentsRoutes = new Hono<Env>()
  // Products for the profile and shop pages: no test products.
  .get('/products', getUser, rateLimit(SOFT_LIMIT), async (c) => {
    const products = await c.get('services').payments.getProfileProductsAsync(null, 'RUB');
    return c.json(products.map(toProductResponse));
  })
  // Start a payment with any provider; the response says how to confirm it. Not for the shared guest (a 401): what it
  // bought would land on the one row every logged-out visitor is. Python lets it buy.
  .post('/start_purchase', getUser, rateLimit(HARD_LIMIT), validate('json', StartPurchaseRequest), async (c) => {
    const body = c.req.valid('json');
    const userId = requireUserId(c);
    try {
      const returnData = await c
        .get('services')
        .payments.startPayment(userId, body.product_id, body.currency, body.provider_id, body.return_url, body.locale);
      return c.json(toStartPurchaseResponse(returnData));
    } catch (e) {
      if (e instanceof PurchaseLimitError) {
        throw new TooManyRequestsError({ code: 'DailyPurchaseLimitError', message: e.message });
      }
      if (e instanceof PaymentValueError) {
        logger.warn(`Invalid payment request from user ${userId}: ${e.message}`);
        throw new BadRequestError(e.message);
      }
      throw e;
    }
  })
  // The status of a payment, owner only, reconciled with the provider when non-final. 404 for not found or not owned;
  // 401 for the shared guest, whose payments are every logged-out visitor's.
  .get('/:payment_id/status', getUser, rateLimit(HARD_LIMIT), async (c) => {
    const userId = requireUserId(c);
    const paymentId = parseUuid(c.req.param('payment_id'));
    if (paymentId === null) throw new NotFoundError('Payment not found');
    const payment = await c.get('services').payments.getPaymentStatus(userId, paymentId);
    if (!payment) throw new NotFoundError('Payment not found');
    return c.json(toPaymentStatusResponse(payment));
  });
