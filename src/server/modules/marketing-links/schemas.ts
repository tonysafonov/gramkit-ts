/** Admin marketing links: a registry of acquisition codes with ready links and results. */
import { z } from 'zod';

/**
 * The code rides in `?startapp=r-<code>` (where '-' separates params) and is stored in `users.referral_code`
 * (varchar 40).
 */
export const CODE_PATTERN = /^[a-z0-9_]{2,40}$/;

/**
 * paid_back: revenue has covered the price; in_progress: not yet, and within its first 14 days; not_paid_back: not
 * yet, 14 days on.
 */
export type Payback = 'paid_back' | 'in_progress' | 'not_paid_back';

const channel = z.string().max(120).nullable();
const priceRub = z.number().min(0).nullable();
const publishedOn = z.iso.date().nullable();

export const MarketingLinkCreateRequest = z.object({
  code: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .refine((value) => CODE_PATTERN.test(value), {
      message: 'Value error, 2–40 characters: lowercase latin letters, digits and _ only',
    }),
  channel: channel.optional(),
  price_rub: priceRub.optional(),
  published_on: publishedOn.optional(),
});
export type MarketingLinkCreateRequest = z.infer<typeof MarketingLinkCreateRequest>;

/** Only the fields the client sent are in the parsed body (an explicit `null` counts as sent). */
export const MarketingLinkUpdateRequest = z.object({
  channel: channel.optional(),
  price_rub: priceRub.optional(),
  published_on: publishedOn.optional(),
  is_archived: z.boolean().nullable().optional(),
});
export type MarketingLinkUpdateRequest = z.infer<typeof MarketingLinkUpdateRequest>;

export interface MarketingLinkStats {
  users: number;
  /** Users with at least one activation event (the app defines it; default: opened the app). */
  activated: number;
  payers: number;
  /** All time, net of refunds, Stars/USD converted at fixed rates. */
  revenueRub: number;
  /** The part the users paid themselves, without automatic renewals. */
  revenuePurchasesRub: number;
  /** Paid within 14 days of the start date. */
  revenueD14Rub: number;
  firstUserAt: Date | null;
  lastUserAt: Date | null;
  firstPaymentAt: Date | null;
  /** Retention: of the users signed up at least N days ago, those active N or more days after signing up. */
  eligibleD1: number;
  returnedD1: number;
  eligibleD7: number;
  returnedD7: number;
  eligibleD30: number;
  returnedD30: number;
}

export const emptyStats = (): MarketingLinkStats => ({
  users: 0,
  activated: 0,
  payers: 0,
  revenueRub: 0,
  revenuePurchasesRub: 0,
  revenueD14Rub: 0,
  firstUserAt: null,
  lastUserAt: null,
  firstPaymentAt: null,
  eligibleD1: 0,
  returnedD1: 0,
  eligibleD7: 0,
  returnedD7: 0,
  eligibleD30: 0,
  returnedD30: 0,
});

export interface MarketingLinkItem {
  /** `null`: the code is in users but not in the registry (pre-registry). */
  id: number | null;
  code: string;
  registered: boolean;
  channel: string | null;
  priceRub: number | null;
  publishedOn: string | null;
  /** `publishedOn`, or the first sign-up for a code without it. */
  startDate: string | null;
  isArchived: boolean;
  createdAt: Date | null;
  appLink: string;
  botLink: string;
  stats: MarketingLinkStats;
  /** price / users */
  cacRub: number | null;
  /** All-time revenue / users. */
  ltvRub: number | null;
  /** All-time revenue / price. */
  roas: number | null;
  /** `null` without a price. */
  payback: Payback | null;
  /** Day (1 = the start date) the revenue first covered the price. */
  paybackDays: number | null;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export const toMarketingLinkItemResponse = (item: MarketingLinkItem) => ({
  id: item.id,
  code: item.code,
  registered: item.registered,
  channel: item.channel,
  price_rub: item.priceRub,
  published_on: item.publishedOn,
  start_date: item.startDate,
  is_archived: item.isArchived,
  created_at: iso(item.createdAt),
  app_link: item.appLink,
  bot_link: item.botLink,
  stats: {
    users: item.stats.users,
    activated: item.stats.activated,
    payers: item.stats.payers,
    revenue_rub: item.stats.revenueRub,
    revenue_purchases_rub: item.stats.revenuePurchasesRub,
    revenue_d14_rub: item.stats.revenueD14Rub,
    first_user_at: iso(item.stats.firstUserAt),
    last_user_at: iso(item.stats.lastUserAt),
    first_payment_at: iso(item.stats.firstPaymentAt),
    eligible_d1: item.stats.eligibleD1,
    returned_d1: item.stats.returnedD1,
    eligible_d7: item.stats.eligibleD7,
    returned_d7: item.stats.returnedD7,
    eligible_d30: item.stats.eligibleD30,
    returned_d30: item.stats.returnedD30,
  },
  cac_rub: item.cacRub,
  ltv_rub: item.ltvRub,
  roas: item.roas,
  payback: item.payback,
  payback_days: item.paybackDays,
});

export const toMarketingLinkListResponse = (items: MarketingLinkItem[]) => ({
  items: items.map(toMarketingLinkItemResponse),
});
