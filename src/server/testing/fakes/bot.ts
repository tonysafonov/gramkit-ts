import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

export interface BotCall {
  method: string;
  payload: Record<string, unknown>;
}

interface ApiFailure {
  error_code: number;
  description: string;
  parameters?: { retry_after?: number };
}

const BOT_INFO: UserFromGetMe = {
  id: 123456789,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

/**
 * A real grammY `Bot` whose API calls never leave the process: they are recorded, and answered with `{ ok: true }`.
 *
 *     fake.calls            // every call, in order
 *     fake.sent('sendMessage')
 *     fake.failNext('sendMessage', { error_code: 403, description: 'Forbidden: bot was blocked by the user' });
 *     fake.bot              // hand this to the code under test
 */
export class FakeBot {
  readonly bot = new Bot('123456789:fake-token', { botInfo: BOT_INFO });
  readonly calls: BotCall[] = [];
  private readonly failures = new Map<string, ApiFailure[]>();
  private messageId = 0;

  constructor() {
    this.bot.api.config.use((_prev, method, payload) => {
      this.calls.push({ method, payload: payload as Record<string, unknown> });
      const failure = this.failures.get(method)?.shift();
      if (failure) return Promise.resolve({ ok: false, ...failure }) as never;
      return Promise.resolve({ ok: true, result: this.resultFor(method, payload as Record<string, unknown>) }) as never;
    });
  }

  private resultFor(method: string, payload: Record<string, unknown>): unknown {
    if (!method.startsWith('send') && !method.startsWith('copy')) return true;
    this.messageId += 1;
    return {
      message_id: this.messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: payload.chat_id, type: 'private' },
      text: payload.text,
    };
  }

  /** The calls of one method. */
  sent(method: string): BotCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** Make the next call of `method` answer with this error. */
  failNext(method: string, failure: ApiFailure): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), failure]);
  }

  clear(): void {
    this.calls.length = 0;
    this.failures.clear();
  }
}
