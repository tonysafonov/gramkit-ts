/**
 * Port of `core/domain/products.py` (the contract) and `app/domain/products.py` (this app's catalog).
 *
 * Services get the catalog injected (`services.products`), so an app can swap it.
 */
import { settings } from '../../config';
import type { Payment } from '../../db/schema';
import { getLogger } from '../../lib/logging';
import type { SubscriptionsService } from '../subscriptions/service';
import type { RecurringDetails } from './types';

const logger = getLogger('products');

export interface CurrencyPrice {
  amount: number;
  currency: string;
}

/**
 * What a product must have. The optional members are read only through the `product*` accessors below:
 * - `invoiceText(locale)`: the Telegram Stars invoice wording, `[title, description]`;
 * - `dailyPurchaseLimit`: purchases per user per 24 h, shared by all limited products;
 * - `takeBack(payment, subscriptions)`: what a refund takes back (returns the note for the owner); `null` means the
 *   subscription period;
 * - `prices`: price per currency; admin MRR prices a subscription only in its own currency.
 */
export interface PaymentProduct {
  productId: string;
  name: string;
  durationDays: number;
  recurring: boolean;
  getPriceFor(currency: string): CurrencyPrice;
  reward(
    userId: string,
    payment: Payment,
    recurringDetails: RecurringDetails,
    subscriptionsService: SubscriptionsService,
  ): Promise<void>;
  invoiceText?(locale: string | null): [title: string, description: string] | null;
  dailyPurchaseLimit?: number | null;
  takeBack?(payment: Payment, subscriptionsService: SubscriptionsService): Promise<string | null>;
  prices?: Record<string, CurrencyPrice>;
}

export const productInvoiceText = (
  product: PaymentProduct | null,
  locale: string | null,
): [title: string, description: string] | null => product?.invoiceText?.(locale) ?? null;

export const productDailyPurchaseLimit = (product: PaymentProduct | null): number | null =>
  product?.dailyPurchaseLimit ?? null;

export const productTakeBack = async (
  product: PaymentProduct | null,
  payment: Payment,
  subscriptionsService: SubscriptionsService,
): Promise<string | null> => (await product?.takeBack?.(payment, subscriptionsService)) ?? null;

/**
 * Price in exactly `currency`, never `getPriceFor()`'s fallback to another one: MRR must not price a RUB subscription
 * with a USD price. `null` when there is no such price.
 */
export function productPriceIn(product: PaymentProduct | null, currency: string): CurrencyPrice | null {
  if (product === null) return null;
  if (product.prices) return product.prices[currency] ?? null;
  try {
    const fallback = product.getPriceFor(currency);
    return fallback.currency === currency ? fallback : null;
  } catch {
    return null;
  }
}

export interface ProductCatalog {
  /** On sale now. */
  AVAILABLE_PRODUCTS: Record<string, PaymentProduct>;
  /** Shown on the profile page; no test products. */
  CURRENT_OFFERS: Record<string, PaymentProduct>;
  /** For development: only in debug mode. */
  TEST_PRODUCTS: Record<string, PaymentProduct>;
  getProduct(productId: string): PaymentProduct | null;
}

export type RewardStrategy = PaymentProduct['reward'];

const defaultReward: RewardStrategy = async (userId, payment) => {
  logger.warn(
    `Default reward: payment ${payment.id} for user ${userId} completed successfully (product ${payment.productId} has no reward handler)`,
  );
};

const topUpReward =
  (label: string, days: number): RewardStrategy =>
  async (userId, payment, recurringDetails, subscriptionsService) => {
    logger.info(`${label} reward: initiating top-up for user ${userId}, payment ${payment.id}`);
    await subscriptionsService.topUpSubscription(userId, payment.productId, days, payment, recurringDetails);
  };

const weeklyReward = topUpReward('Weekly', 7);
const monthlyReward = topUpReward('Monthly', 30);
const yearlyReward = topUpReward('Yearly', 365);

interface ProductFields {
  productId: string;
  name: string;
  durationDays: number;
  prices: Record<string, CurrencyPrice>;
  recurring?: boolean;
  rewardHandler?: RewardStrategy;
}

/** A product of this app's catalog. */
export class Product implements PaymentProduct {
  readonly productId: string;
  readonly name: string;
  readonly durationDays: number;
  readonly prices: Record<string, CurrencyPrice>;
  readonly recurring: boolean;
  readonly rewardHandler: RewardStrategy;

  constructor({ productId, name, durationDays, prices, recurring = false, rewardHandler }: ProductFields) {
    this.productId = productId;
    this.name = name;
    this.durationDays = durationDays;
    this.prices = prices;
    this.recurring = recurring;
    this.rewardHandler = rewardHandler ?? defaultReward;
  }

  getPriceFor(currency: string): CurrencyPrice {
    const price = this.prices[currency] ?? Object.values(this.prices)[0];
    if (!price) throw new Error(`Product ${this.productId} has no prices`);
    return price;
  }

  reward(...args: Parameters<RewardStrategy>): Promise<void> {
    return this.rewardHandler(...args);
  }
}

const rub = (amount: number): CurrencyPrice => ({ amount, currency: 'RUB' });
const usd = (amount: number): CurrencyPrice => ({ amount, currency: 'USD' });
const xtr = (amount: number): CurrencyPrice => ({ amount, currency: 'XTR' });

const weekly = (productId: string, rubles: number, dollars: number) =>
  new Product({
    productId,
    name: 'Weekly Subscription',
    durationDays: 7,
    prices: { RUB: rub(rubles), USD: usd(dollars) },
    recurring: true,
    rewardHandler: weeklyReward,
  });

const monthly = (productId: string, rubles: number, dollars: number) =>
  new Product({
    productId,
    name: 'Monthly Subscription',
    durationDays: 30,
    prices: { RUB: rub(rubles), USD: usd(dollars) },
    recurring: true,
    rewardHandler: monthlyReward,
  });

const yearly = (productId: string, rubles: number, dollars: number) =>
  new Product({
    productId,
    name: 'Yearly Subscription',
    durationDays: 365,
    prices: { RUB: rub(rubles), USD: usd(dollars) },
    recurring: true,
    rewardHandler: yearlyReward,
  });

/** Inactive, kept for existing subscriptions. */
export const LEGACY_PRODUCTS: Record<string, PaymentProduct> = {
  WEEK_SUB: weekly('WEEK_SUB', 129, 1.49),
  MONTH_SUB: monthly('MONTH_SUB', 249, 2.99),
  YEAR_SUB: yearly('YEAR_SUB', 749, 7.99),
  WEEK_SUB_V2: weekly('WEEK_SUB_V2', 169, 1.99),
  MONTH_SUB_V2: monthly('MONTH_SUB_V2', 349, 3.99),
  YEAR_SUB_V2: yearly('YEAR_SUB_V2', 849, 9.99),
};

export const AVAILABLE_PRODUCTS: Record<string, PaymentProduct> = {
  WEEK_SUB_V3: weekly('WEEK_SUB_V3', 222, 1.99),
  MONTH_SUB_V3: monthly('MONTH_SUB_V3', 555, 3.99),
  YEAR_SUB_V3: yearly('YEAR_SUB_V3', 999, 9.99),
};

export const TEST_PRODUCTS: Record<string, PaymentProduct> = {
  TEST_ONETIME: new Product({
    productId: 'TEST_ONETIME',
    name: 'Test One-time Payment',
    durationDays: 7,
    prices: { XTR: xtr(1) },
  }),
  TEST_SUBSCRIPTION: new Product({
    productId: 'TEST_SUBSCRIPTION',
    name: 'Test Subscription',
    durationDays: 30,
    prices: { XTR: xtr(1) },
    recurring: true,
    rewardHandler: monthlyReward,
  }),
};

export const CURRENT_OFFERS = AVAILABLE_PRODUCTS;

const ALL_PRODUCTS: Record<string, PaymentProduct> = { ...LEGACY_PRODUCTS, ...AVAILABLE_PRODUCTS };

/** By id, active and legacy; test products too in debug mode. */
export function getProduct(productId: string): PaymentProduct | null {
  const all = settings.debug ? { ...ALL_PRODUCTS, ...TEST_PRODUCTS } : ALL_PRODUCTS;
  return Object.hasOwn(all, productId) ? (all[productId] ?? null) : null;
}

export const products: ProductCatalog = { AVAILABLE_PRODUCTS, CURRENT_OFFERS, TEST_PRODUCTS, getProduct };
