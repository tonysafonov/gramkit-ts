import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { posthog } from '../../clients/posthog';
import { runWithRequestContext } from '../../lib/request-context';
import type { BotContext } from '../context';
import { refCommand, startCommand as start } from './start';

// The menu text is translated with the request's language
const startCommand: typeof start = (...args) =>
  runWithRequestContext({ requestId: 'test', locale: 'en' }, () => start(...args));

// Bot `/start <code>` never stores one of the app's own link codes as an acquisition source. Same rule as
// `StartService` for the Mini App's `?startapp=r-<code>`: the codes come from `services.internalReferalIds`.

function setup() {
  const services = {
    internalReferalIds: new Set(['ownlink']),
    users: { processReferal: vi.fn(), clearBotBlocked: vi.fn() },
    invites: { processInvite: vi.fn() },
  };
  const reply = vi.fn();
  const user = { id: 'user-1', telegramId: 123, botBlockedAt: null as Date | null };
  const ctx = { user, services, reply, from: { username: 'nick', language_code: 'en' } } as unknown as BotContext;
  return { ctx, services, reply, user };
}

beforeEach(() => {
  vi.spyOn(posthog, 'capture').mockReturnValue(true);
});

afterEach(() => vi.restoreAllMocks());

describe('startCommand', () => {
  it("does not store the app's own code, and still sends the menu", async () => {
    const { ctx, services, reply } = setup();
    await startCommand(ctx, 'ownlink');
    expect(services.users.processReferal).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
  });

  it('stores an external code', async () => {
    const { ctx, services, user } = setup();
    await startCommand(ctx, 'partner_post3');
    expect(services.users.processReferal).toHaveBeenCalledExactlyOnceWith('partner_post3', user.id);
  });

  it("skips a custom processor for the app's own code too", async () => {
    const { ctx } = setup();
    const referralProcessor = vi.fn();
    await startCommand(ctx, 'ownlink', { referralProcessor });
    expect(referralProcessor).not.toHaveBeenCalled();
  });

  it('uses a custom processor for an external code', async () => {
    const { ctx, services, user } = setup();
    const referralProcessor = vi.fn();
    await startCommand(ctx, 'partner', { referralProcessor });
    expect(referralProcessor).toHaveBeenCalledExactlyOnceWith('partner', user.id);
    expect(services.users.processReferal).not.toHaveBeenCalled();
  });

  it('invites and a plain start are unchanged', async () => {
    const { ctx, services } = setup();
    await startCommand(ctx, 'i_abc');
    expect(services.invites.processInvite).toHaveBeenCalledOnce();
    expect(services.invites.processInvite.mock.calls[0]?.[0]).toBe('abc');
    await startCommand(ctx, null);
    expect(services.users.processReferal).not.toHaveBeenCalled();
  });

  it('clears the blocked flag: /start after a block means the bot can write again', async () => {
    const { ctx, services, user } = setup();
    user.botBlockedAt = new Date();
    await startCommand(ctx, null);
    expect(services.users.clearBotBlocked).toHaveBeenCalledExactlyOnceWith(user.id);
  });

  it('captures the analytics event with the referral code', async () => {
    const { ctx } = setup();
    await startCommand(ctx, 'partner');
    expect(posthog.capture).toHaveBeenCalledWith('123', 'bot_command_start', {
      user_id: 'user-1',
      telegram_id: 123,
      referral_code: 'partner',
      username: 'nick',
      language: 'en',
    });
  });
});

describe('refCommand', () => {
  const options = { botUrl: 'https://t.me/mybot' };

  it('sends the plain links without a code', async () => {
    const { ctx, reply } = setup();
    await refCommand(ctx, null, options);
    expect(reply).toHaveBeenCalledWith('https://t.me/mybot\n\nhttps://t.me/mybot/app', {
      link_preview_options: { is_disabled: true },
    });
  });

  it('carries the bare code in the bot link and the prefixed one in the app link', async () => {
    const { ctx, reply } = setup();
    await refCommand(ctx, '123', options);
    expect(reply.mock.calls[0]?.[0]).toBe('https://t.me/mybot?start=123\n\nhttps://t.me/mybot/app?startapp=r-123');
  });
});
