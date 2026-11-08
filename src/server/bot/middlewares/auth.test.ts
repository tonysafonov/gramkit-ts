import type { Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../context';
import {
  callbackUpdate,
  messageUpdate,
  myChatMemberUpdate,
  preCheckoutUpdate,
  reactionUpdate,
  tgUser,
} from '../test-utils';
import { authMiddleware, isUserCreatingEvent, shouldSkipUserCreation } from './auth';

// The bot must only persist users for genuine interactions where it has a private chat it can reply in (private
// message, callback query, payment query). Membership and observation updates (`my_chat_member`, `chat_member`,
// `message_reaction`, ...) reference a user the bot merely *sees*: persisting them mints "ghost" users who never
// started the bot, can't be messaged, and pollute user counts and DAU/MAU.

describe('isUserCreatingEvent', () => {
  it.each([
    ['private message', messageUpdate('hi')],
    ['callback query', callbackUpdate('x')],
    ['pre-checkout query', preCheckoutUpdate()],
  ])('real interaction creates: %s', (_name, update) => {
    expect(isUserCreatingEvent(update)).toBe(true);
  });

  it.each([
    ['group message', messageUpdate('hi', tgUser(), 'supergroup')],
    ['my_chat_member', myChatMemberUpdate()],
    ['message_reaction', reactionUpdate()],
  ])('observation update does not create: %s', (_name, update) => {
    expect(isUserCreatingEvent(update)).toBe(false);
  });
});

describe('shouldSkipUserCreation', () => {
  it('skips /start link_*, which the telegram-link composer handles itself', () => {
    expect(shouldSkipUserCreation(messageUpdate('/start link_abc'))).toBe(true);
  });

  it('skips the link confirmation button too', () => {
    expect(shouldSkipUserCreation(callbackUpdate('link_ok:abc'))).toBe(true);
    expect(shouldSkipUserCreation(callbackUpdate('auth_ok:abc'))).toBe(false);
  });

  it('does not skip other starts', () => {
    expect(shouldSkipUserCreation(messageUpdate('/start'))).toBe(false);
    expect(shouldSkipUserCreation(messageUpdate('/start r-abc'))).toBe(false);
    expect(shouldSkipUserCreation(callbackUpdate('x'))).toBe(false);
  });
});

describe('authMiddleware gate', () => {
  async function run(update: Update) {
    const getOrCreateUser = vi.fn().mockResolvedValue({ id: 'u1' });
    const next = vi.fn().mockResolvedValue(undefined);
    const message = update.message ?? update.edited_message;
    const ctx = {
      update,
      from:
        message?.from ?? update.callback_query?.from ?? update.pre_checkout_query?.from ?? update.my_chat_member?.from,
      services: { users: { getOrCreateUser } },
    } as unknown as BotContext;
    await authMiddleware()(ctx, next);
    return { ctx, getOrCreateUser, next };
  }

  it('creates the user for a private message', async () => {
    const { ctx, getOrCreateUser, next } = await run(messageUpdate('hi'));
    expect(getOrCreateUser).toHaveBeenCalledOnce();
    expect(getOrCreateUser.mock.calls[0]?.[0]).toMatchObject({
      telegramId: 42,
      displayName: 'Test',
      tgUsername: 'test',
      userType: 'REGISTERED',
    });
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.user).toEqual({ id: 'u1' });
  });

  it('does not create a user for my_chat_member, but the handler still runs', async () => {
    const { getOrCreateUser, next } = await run(myChatMemberUpdate());
    expect(getOrCreateUser).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not create a user for a reaction', async () => {
    const { getOrCreateUser, next } = await run(reactionUpdate());
    expect(getOrCreateUser).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('leaves /start link_* to its own handler', async () => {
    const { getOrCreateUser, next } = await run(messageUpdate('/start link_abc'));
    expect(getOrCreateUser).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('names a user without a first name after the username, then "User"', async () => {
    const { getOrCreateUser } = await run(messageUpdate('hi', tgUser({ first_name: '', username: 'nick' })));
    expect(getOrCreateUser.mock.calls[0]?.[0].displayName).toBe('nick');
    const second = await run(messageUpdate('hi', tgUser({ first_name: '', username: undefined })));
    expect(second.getOrCreateUser.mock.calls[0]?.[0].displayName).toBe('User');
  });
});
