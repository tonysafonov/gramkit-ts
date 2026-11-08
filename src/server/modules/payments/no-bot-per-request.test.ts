/**
 * PaymentsService and the Telegram Stars provider must not build a bot per request. Port of
 * `test_payments_bot_reuse.py`: a load test found 76% of `GET /payments/products` in building one.
 */
import { Bot } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { getSharedBot } from '../../clients/bot';
import { PaymentProvider } from '../../db/schema';
import type { Repos } from '../../repos';
import type { Services } from '../../services';
import { FakeBot } from '../../testing';
import { products } from './products';
import { getProvider } from './providers';
import { TelegramStarsProvider } from './providers/telegram-stars';
import { PaymentsService } from './service';

vi.mock('./providers', async (importOriginal) => {
  const original = await importOriginal<typeof import('./providers')>();
  return { ...original, getProvider: vi.fn(original.getProvider) };
});

vi.mock('../../clients/bot', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../clients/bot')>();
  return { ...original, getSharedBot: vi.fn(original.getSharedBot) };
});

const STARS = PaymentProvider.TELEGRAM_STARS;
const repos = {} as Repos;

const paymentsWith = (bot: Bot | null) => {
  vi.mocked(getProvider).mockClear();
  vi.mocked(getSharedBot).mockClear();
  return new PaymentsService(repos, {} as never, { bot } as Services, bot, products);
};

describe('no bot per request', () => {
  it('building the service builds no provider and no bot', () => {
    const payments = paymentsWith(null);

    expect(payments.providers.keys()).toEqual([PaymentProvider.YOOKASSA, STARS]);
    expect(payments.providers.has(STARS)).toBe(true);
    expect(payments.providers.get(PaymentProvider.GIFT)).toBeNull();
    expect(getProvider).not.toHaveBeenCalled();
    expect(getSharedBot).not.toHaveBeenCalled();
  });

  it('a provider is built once, on first lookup', () => {
    const payments = paymentsWith(null);

    const first = payments.providers.get(STARS);

    expect(payments.providers.get(STARS)).toBe(first);
    expect(getProvider).toHaveBeenCalledTimes(1);
  });

  it('building the Stars provider builds no bot', () => {
    const provider = paymentsWith(null).providers.get(STARS);

    expect(provider).toBeInstanceOf(TelegramStarsProvider);
    expect(getSharedBot).not.toHaveBeenCalled();
  });

  it('the Stars provider uses the services bot', () => {
    const { bot } = new FakeBot();

    const provider = paymentsWith(bot).providers.get(STARS) as TelegramStarsProvider;

    expect(provider.bot).toBe(bot);
    expect(getSharedBot).not.toHaveBeenCalled();
  });

  it('with no process bot every provider shares one fallback bot', () => {
    const first = new TelegramStarsProvider(repos, { bot: null } as Services, products).bot;
    // Not a grammY Bot (an app's null bot): don't reuse it for payments.
    const second = new TelegramStarsProvider(repos, { bot: {} } as Services, products).bot;

    expect(first).toBeInstanceOf(Bot);
    expect(second).toBe(first);
  });

  it('an assigned bot overrides the lazy one', () => {
    const provider = new TelegramStarsProvider(repos, { bot: new FakeBot().bot } as Services, products);
    const { bot } = new FakeBot();

    provider.bot = bot;

    expect(provider.bot).toBe(bot);
  });
});
