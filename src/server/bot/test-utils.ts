/** Telegram `Update` builders for bot tests. */
import type { Update, User } from 'grammy/types';

const TS = 1_700_000_000;

export const tgUser = (overrides: Partial<User> = {}): User => ({
  id: 42,
  is_bot: false,
  first_name: 'Test',
  username: 'test',
  ...overrides,
});

let updateId = 0;
const nextUpdateId = () => {
  updateId += 1;
  return updateId;
};

/** A private-chat text message from `from`. Commands get their `bot_command` entity, as Telegram sends them. */
export function messageUpdate(
  text: string,
  from: User = tgUser(),
  chatType: 'private' | 'supergroup' = 'private',
): Update {
  const command = /^\/\w+(@\w+)?/.exec(text);
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      date: TS,
      chat: { id: chatType === 'private' ? from.id : -100, type: chatType } as never,
      from,
      text,
      entities: command ? [{ type: 'bot_command', offset: 0, length: command[0].length }] : undefined,
    },
  };
}

export function callbackUpdate(data: string, from: User = tgUser()): Update {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: `cb${nextUpdateId()}`,
      from,
      chat_instance: 'ci',
      data,
      message: {
        message_id: 1,
        date: TS,
        chat: { id: from.id, type: 'private' },
        from: tgUser({ id: 1, is_bot: true }),
      } as never,
    },
  };
}

export const preCheckoutUpdate = (from: User = tgUser()): Update => ({
  update_id: nextUpdateId(),
  pre_checkout_query: { id: 'p', from, currency: 'XTR', total_amount: 100, invoice_payload: 'p' },
});

export const myChatMemberUpdate = (from: User = tgUser()): Update => ({
  update_id: nextUpdateId(),
  my_chat_member: {
    chat: { id: from.id, type: 'private' } as never,
    from,
    date: TS,
    old_chat_member: { status: 'member', user: from } as never,
    new_chat_member: { status: 'left', user: from } as never,
  },
});

export const reactionUpdate = (from: User = tgUser()): Update => ({
  update_id: nextUpdateId(),
  message_reaction: {
    chat: { id: from.id, type: 'private' } as never,
    message_id: 5,
    date: TS,
    old_reaction: [],
    new_reaction: [{ type: 'emoji', emoji: '👍' }],
    user: from,
  },
});
