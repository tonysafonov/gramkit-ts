/**
 * Admin marketing links (acquisition attribution): register a code per external placement, hand out its Mini App /
 * bot links, and show what it brought.
 *
 * Results come from `users.referral_code` (first touch), so codes used before the registry existed are listed too,
 * unregistered, to be given a channel name. Codes of the app's own links to existing users (notifications,
 * broadcasts; `Services.internalReferalIds`) are not acquisition and never listed or registrable.
 *
 * What counts as *activity* (activated users, return after N days) is the app's call: it sets
 * `Services.marketingLinksConfig`. Without one, activity = the user opened the app (`users.last_activity_date`).
 */
import type { SQL } from 'drizzle-orm';
import { settings } from '../../config';
import { BaseService } from '../../lib/base-service';
import { MarketingCodeNotAllowedException, MarketingLinkNotFoundException } from '../../lib/errors';
import { roundHalfEven } from '../analytics/math';
import { esc, fmtMoney, tags } from '../messages/admin-messages';
import type { UserSchema } from '../users/schemas';
import { defaultActivity, MarketingLinksRepo } from './repo';
import {
  emptyStats,
  type MarketingLinkCreateRequest,
  type MarketingLinkItem,
  type MarketingLinkStats,
  type MarketingLinkUpdateRequest,
  type Payback,
} from './schemas';

const DAY_MS = 86_400_000;
const D14_MS = 14 * DAY_MS;
/** Owner digests go out this many days after the publish date. */
const DIGEST_DAYS = [1, 7, 14] as const;

/**
 * Rough fixed rates to put every payment in rubles, good enough to tell whether a placement paid back: Stars at the
 * developer payout (~$0.013/star), dollars at ~85 RUB. An app overrides them with `MarketingLinksConfig.rubPerUnit`.
 */
export const DEFAULT_RUB_PER_UNIT: Readonly<Record<string, number>> = { RUB: 1.0, USD: 85.0, XTR: 1.1 };

/** A SQL SELECT (or UNION ALL) whose rows are labelled `user_id` and `at`. */
export type ActivityQuery = () => SQL;

/**
 * How an app measures its marketing links. The hooks are query fragments, not callbacks: they are joined per user
 * inside one aggregate query.
 */
export interface MarketingLinksConfig {
  /** Users with any row count as `activated`. Omitted: they opened the app. */
  activation?: ActivityQuery | null;
  /** Rows that count for return (retention): the latest `at` per user. Omitted: `activation`. */
  activity?: ActivityQuery | null;
  /** English, used in owner digests: "40% opened the app". */
  activationLabel?: string;
  rubPerUnit?: Readonly<Record<string, number>>;
}

/** Opens the Mini App; the app records `r-<code>` on the first session. */
export const appLink = (base: string, code: string): string => `${base}?startapp=r-${code}`;

/** Opens the bot chat; /start records the code right away. */
export const botLink = (base: string, code: string): string => `${base}?start=${code}`;

export interface Economics {
  cacRub: number | null;
  ltvRub: number | null;
  roas: number | null;
  payback: Payback | null;
  paybackDays: number | null;
}

/**
 * CAC, LTV (revenue per user), ROAS (revenue / price) and payback: the day the running revenue first covered the price
 * or, until it does, whether the code is still in its first 14 days.
 */
export function economics(
  price: number | null,
  stats: Pick<MarketingLinkStats, 'users' | 'revenueRub'>,
  start: Date | null,
  payments: [Date, number][],
): Economics {
  const { users } = stats;
  let payback: Payback | null = null;
  let paybackDays: number | null = null;
  if (price) {
    let running = 0;
    let covered = false;
    for (const [paidAt, rub] of payments) {
      running += rub;
      if (running >= price) {
        payback = 'paid_back';
        paybackDays = start ? Math.max(Math.floor((paidAt.getTime() - start.getTime()) / DAY_MS) + 1, 1) : null;
        covered = true;
        break;
      }
    }
    if (!covered) {
      const late = start !== null && Date.now() >= start.getTime() + D14_MS;
      payback = late ? 'not_paid_back' : 'in_progress';
    }
  }
  return {
    cacRub: price !== null && users ? roundHalfEven(price / users, 2) : null,
    ltvRub: users ? roundHalfEven(stats.revenueRub / users, 2) : null,
    roas: price ? roundHalfEven(stats.revenueRub / price, 2) : null,
    payback,
    paybackDays,
  };
}

export interface MarketingAlert {
  linkId: number;
  /** Stored in `marketing_links.alerts_sent` so it goes out once. */
  key: string;
  text: string;
  silent: boolean;
}

/** A unique-constraint violation (Postgres 23505), however the driver or Drizzle wrapped it. */
function isUniqueViolation(error: unknown): boolean {
  for (let err: unknown = error, depth = 0; err && depth < 5; depth += 1) {
    if (typeof err === 'object' && (err as { code?: unknown }).code === '23505') return true;
    err = (err as { cause?: unknown }).cause;
  }
  return false;
}

const startOfDay = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

export class MarketingLinksService extends BaseService {
  private config() {
    const config = this.services.marketingLinksConfig ?? {};
    return {
      activation: config.activation ?? null,
      activity: config.activity ?? null,
      activationLabel: config.activationLabel ?? 'opened the app',
      rubPerUnit: config.rubPerUnit ?? DEFAULT_RUB_PER_UNIT,
    };
  }

  /** The app's own link codes (re-engagement, not acquisition). */
  private internalCodes(): ReadonlySet<string> {
    return new Set(this.services.internalReferalIds);
  }

  /** (Mini App URL, bot URL). One seam, so tests can set them without app settings. */
  protected linkBases(): [string, string] {
    return [settings.web.appUrl, settings.bot.url];
  }

  async listLinks(): Promise<MarketingLinkItem[]> {
    const cfg = this.config();
    const { marketingLinks: repo } = this.repos;
    const activation = (cfg.activation ?? defaultActivity)();
    const activity = (cfg.activity ?? cfg.activation ?? defaultActivity)();
    const stats = await repo.statsByCode({ activation, activity });
    const links = await repo.listAll();
    const publishedOn = new Map(links.map((link) => [link.code, link.publishedOn]));
    const [appBase, botBase] = this.linkBases();
    const internal = this.internalCodes();

    // A code's clock starts the day the post went out or, with no date set (e.g. codes from before this page), at its
    // first sign-up.
    const startOf = (code: string): Date | null => {
      const published = publishedOn.get(code);
      return published ? startOfDay(published) : (stats.get(code)?.firstUserAt ?? null);
    };

    const payments = new Map<string, [Date, number][]>();
    const purchases = new Map<string, number>(); // without subscription auto-renewals
    for (const payment of await repo.paymentsByCode()) {
      const rub = payment.amount * (cfg.rubPerUnit[payment.currency] ?? 0.0);
      const list = payments.get(payment.code) ?? [];
      list.push([payment.createdAt, rub]);
      payments.set(payment.code, list);
      if (payment.isPurchase) purchases.set(payment.code, (purchases.get(payment.code) ?? 0) + rub);
    }

    const item = (code: string, link: (typeof links)[number] | null): MarketingLinkItem => {
      const start = startOf(code);
      const codePayments: [Date, number][] = payments.get(code) ?? [];
      const revenue = codePayments.reduce((sum, [, rub]) => sum + rub, 0);
      const revenueD14 = codePayments.reduce(
        (sum, [paidAt, rub]) => (start && paidAt.getTime() < start.getTime() + D14_MS ? sum + rub : sum),
        0,
      );
      const codeStats: MarketingLinkStats = {
        ...emptyStats(),
        ...stats.get(code),
        revenueRub: roundHalfEven(revenue, 2),
        revenuePurchasesRub: roundHalfEven(purchases.get(code) ?? 0, 2),
        revenueD14Rub: roundHalfEven(revenueD14, 2),
        firstPaymentAt: codePayments[0]?.[0] ?? null,
      };
      stats.delete(code);
      const price = link?.priceRub ?? null;
      return {
        id: link?.id ?? null,
        code,
        registered: link !== null,
        channel: link?.channel ?? null,
        priceRub: price,
        publishedOn: link?.publishedOn ?? null,
        startDate: start ? start.toISOString().slice(0, 10) : null,
        isArchived: link?.isArchived ?? false,
        createdAt: link?.createdAt ?? null,
        appLink: appLink(appBase, code),
        botLink: botLink(botBase, code),
        stats: codeStats,
        ...economics(price, codeStats, start, codePayments),
      };
    };

    const items = links.map((link) => item(link.code, link));
    const unregistered = [...stats.entries()].sort(([, a], [, b]) => b.users - a.users);
    for (const [code] of unregistered) if (!internal.has(code)) items.push(item(code, null));
    return items;
  }

  /**
   * Register a code. Throws `MarketingCodeNotAllowedException` for one of the app's own codes or a code that's
   * already registered (also when a concurrent request just took it).
   */
  async create(actor: UserSchema, body: MarketingLinkCreateRequest): Promise<MarketingLinkItem> {
    const { marketingLinks: repo } = this.repos;
    if (this.internalCodes().has(body.code)) {
      throw new MarketingCodeNotAllowedException("This code is used by the app's own notifications");
    }
    if (await repo.getByCode(body.code)) throw new MarketingCodeNotAllowedException('This code is already registered');
    let link: Awaited<ReturnType<MarketingLinksRepo['create']>>;
    try {
      // A savepoint: a concurrent create of the same code fails on the unique constraint without poisoning the
      // request transaction, and becomes the same 400.
      link = await this.repos.db.transaction((tx) =>
        new MarketingLinksRepo(tx).create({
          code: body.code,
          channel: body.channel?.trim() || null,
          priceRub: body.price_rub ?? null,
          publishedOn: body.published_on ?? null,
          createdBy: actor.username || String(actor.id),
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new MarketingCodeNotAllowedException('This code is already registered');
      throw err;
    }
    await this.services.auditLog.record(actor, 'marketing_link_create', 'marketing_link', link.code, {
      channel: link.channel,
    });
    return this.item(link.code);
  }

  /** Edit a link (channel, price, publish date, archived). Throws `MarketingLinkNotFoundException`. */
  async update(actor: UserSchema, linkId: number, body: MarketingLinkUpdateRequest): Promise<MarketingLinkItem> {
    const { marketingLinks: repo } = this.repos;
    const link = await repo.getById(linkId);
    if (!link) throw new MarketingLinkNotFoundException('Marketing link not found');

    // The wire (snake_case) changes go to the audit detail; the columns are camelCase.
    const changes: Record<string, unknown> = { ...body };
    if (changes.is_archived === null) delete changes.is_archived; // an explicit null leaves the flag alone (NOT NULL)
    if (typeof changes.channel === 'string') changes.channel = changes.channel.trim() || null;

    const columns: Record<string, unknown> = {};
    if ('channel' in changes) columns.channel = changes.channel;
    if ('price_rub' in changes) columns.priceRub = changes.price_rub;
    if ('published_on' in changes) columns.publishedOn = changes.published_on;
    if ('is_archived' in changes) columns.isArchived = changes.is_archived;
    if (Object.keys(columns).length > 0) await repo.update(linkId, columns);

    await this.services.auditLog.record(actor, 'marketing_link_update', 'marketing_link', link.code, changes);
    return this.item(link.code);
  }

  private async item(code: string): Promise<MarketingLinkItem> {
    const found = (await this.listLinks()).find((item) => item.code === code);
    if (!found) throw new Error(`Marketing link ${code} is missing from the listing`);
    return found;
  }

  // Owner alerts (sent hourly by marketingLinksAlertsJob) -------------------------------------------------------

  /**
   * Alerts due for live links: the first user and the first payment (only if they came after the link was saved
   * here, so registering an old code doesn't replay its history), and a digest on days 1, 7 and 14 after the publish
   * date.
   */
  async pendingAlerts(): Promise<MarketingAlert[]> {
    const now = Date.now();
    const label = this.config().activationLabel;
    const links = new Map((await this.repos.marketingLinks.listAll()).map((link) => [link.id, link]));
    const alerts: MarketingAlert[] = [];
    for (const item of await this.listLinks()) {
      const link = item.id === null ? undefined : links.get(item.id);
      if (!link || link.isArchived) continue;
      const sent = new Set(link.alertsSent ?? []);
      const { stats } = item;
      if (!sent.has('first_user') && stats.firstUserAt && stats.firstUserAt >= link.createdAt) {
        alerts.push({ linkId: link.id, key: 'first_user', text: firstUserText(item), silent: false });
      }
      if (!sent.has('first_payment') && stats.firstPaymentAt && stats.firstPaymentAt >= link.createdAt) {
        alerts.push({ linkId: link.id, key: 'first_payment', text: firstPaymentText(item), silent: false });
      }
      if (item.publishedOn) {
        const start = startOfDay(item.publishedOn).getTime();
        for (const day of DIGEST_DAYS) {
          const due = start + day * DAY_MS;
          if (!sent.has(`day_${day}`) && due <= now && now < due + DAY_MS) {
            alerts.push({ linkId: link.id, key: `day_${day}`, text: digestText(item, day, label), silent: true });
          }
        }
      }
    }
    return alerts;
  }

  async markAlertsSent(alerts: MarketingAlert[]): Promise<void> {
    const keys = new Map<number, Set<string>>();
    for (const alert of alerts) {
      const set = keys.get(alert.linkId) ?? new Set<string>();
      set.add(alert.key);
      keys.set(alert.linkId, set);
    }
    for (const [linkId, newKeys] of keys) {
      const link = await this.repos.marketingLinks.getById(linkId);
      if (link) {
        await this.repos.marketingLinks.update(linkId, {
          alertsSent: [...new Set([...(link.alertsSent ?? []), ...newKeys])].sort(),
        });
      }
    }
  }
}

const rub = (amount: number | null): string => (amount !== null ? fmtMoney(Math.round(amount), 'RUB') : '—');

const title = (item: MarketingLinkItem): string =>
  `<code>${esc(item.code)}</code>${item.channel ? ` · ${esc(item.channel)}` : ''}`;

const itemTags = (item: MarketingLinkItem): string => tags('marketing', `code_${item.code}`);

const firstUserText = (item: MarketingLinkItem): string =>
  `👋 <b>First user</b> · ${title(item)}\n<i>The link works.</i>\n${itemTags(item)}`;

const firstPaymentText = (item: MarketingLinkItem): string =>
  `💸 <b>First payment</b> · ${title(item)}\n` +
  `<i>${item.stats.users} users so far · revenue ${rub(item.stats.revenueRub)}</i>\n${itemTags(item)}`;

function digestText(item: MarketingLinkItem, day: number, activationLabel: string): string {
  const { stats } = item;
  const share = (part: number): string => (stats.users ? `${Math.round((part / stats.users) * 100)}%` : '—');
  const lines = [
    `📣 <b>Day ${day}</b> · ${title(item)}`,
    `${stats.users} users · ${share(stats.activated)} ${esc(activationLabel)} · ${stats.payers} paid (${share(stats.payers)})`,
    `Revenue ${rub(stats.revenueRub)} · purchases ${rub(stats.revenuePurchasesRub)}`,
  ];
  if (item.priceRub) {
    const verdict = {
      paid_back: `✅ paid back in ${item.paybackDays} d`,
      in_progress: '⏳ not yet',
      not_paid_back: '❌ not paid back in 14 days',
    }[item.payback ?? 'in_progress'];
    lines.push(`Price ${rub(item.priceRub)} · CAC ${rub(item.cacRub)} · ×${(item.roas ?? 0).toFixed(2)} ${verdict}`);
  } else {
    lines.push('<i>No price set, so no payback.</i>');
  }
  if (day === 1 && !stats.users) lines.push('⚠️ Nobody came in a day: check the link in the post.');
  lines.push(itemTags(item));
  return lines.join('\n');
}
