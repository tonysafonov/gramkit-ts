import { boolean, date, doublePrecision, json, pgTable, serial, unique, varchar } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns';

/**
 * A registered acquisition code: one per external placement (post, ad, partner). The code travels in the link
 * (`?startapp=r-<code>` / `?start=<code>`) and ends up in `users.referral_code` on the user's first touch, so
 * per-code results come from there.
 */
export const marketingLinks = pgTable(
  'marketing_links',
  {
    id: serial('id').primaryKey(),
    code: varchar('code', { length: 40 }).notNull(), // a-z, 0-9, _
    channel: varchar('channel', { length: 120 }), // where it ran, e.g. "Partner channel, post 3"
    priceRub: doublePrecision('price_rub'), // what the placement cost
    publishedOn: date('published_on', { mode: 'string' }), // day the post went out: D14 starts here
    createdBy: varchar('created_by', { length: 128 }),
    isArchived: boolean('is_archived').notNull().default(false),
    // Owner alerts already sent for this link ("first_user", "first_payment", "day_1", ...).
    alertsSent: json('alerts_sent').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('marketing_links_code_key').on(t.code)],
);

export type MarketingLink = typeof marketingLinks.$inferSelect;
export type NewMarketingLink = typeof marketingLinks.$inferInsert;
