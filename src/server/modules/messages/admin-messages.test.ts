/**
 * Admin-message formatting helpers and the degrading sender (port of `test_admin_messages.py`).
 *
 * The sender's contract: an admin alert is never lost to formatting: a rejected rich body falls back to HTML, rejected
 * HTML falls back to plain text.
 */
import type { Bot } from 'grammy';
import { GrammyError } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../config';
import {
  alertOwners,
  announceStart,
  bulletList,
  esc,
  fmtDelta,
  fmtMoney,
  fmtMoneyMap,
  htmlToPlain,
  sendAdminMessage,
  tags,
  userRef,
  userTag,
} from './admin-messages';

// The process-wide fallback bot: a fake, handed out the way `getSharedBot()` hands out its one bot.
const shared = vi.hoisted(() => ({ bot: null as unknown, calls: 0 }));
vi.mock('../../clients/bot', () => ({
  getSharedBot: () => {
    shared.calls += 1;
    return shared.bot;
  },
}));

const badRequest = (text = "can't parse entities") =>
  new GrammyError(text, { ok: false, error_code: 400, description: text }, 'sendMessage', {});

interface Sent {
  chat_id: number;
  text: string;
  parse_mode?: string;
  disable_notification?: boolean;
}

/** Records sends; each method can be told to raise. */
class FakeBot {
  rich: { chat_id: number; html: string; disable_notification?: boolean }[] = [];
  sent: Sent[] = [];
  richError: Error | null = null;
  htmlError: Error | null = null;
  failChat: number | null = null;

  api = {
    sendRichMessage: async (
      chatId: number,
      richMessage: { html: string },
      other: { disable_notification?: boolean },
    ) => {
      if (this.richError) throw this.richError;
      this.rich.push({ chat_id: chatId, html: richMessage.html, ...other });
    },
    sendMessage: async (
      chatId: number,
      text: string,
      other: { parse_mode?: string; disable_notification?: boolean } = {},
    ) => {
      if (chatId === this.failChat) throw new Error('network');
      if (other.parse_mode === 'HTML' && this.htmlError) throw this.htmlError;
      this.sent.push({ chat_id: chatId, text, ...other });
    },
  };

  asBot = () => this as unknown as Bot;
}

describe('formatting', () => {
  it('esc neutralises html', () => {
    expect(esc('<3 & "x"')).toBe('&lt;3 &amp; &quot;x&quot;');
  });

  it('userRef links the telegram handle', () => {
    const user = { tgUsername: 'anna', username: 'anna_app', telegramId: 42 };
    expect(userRef(user)).toBe('<a href="tg://user?id=42">@anna</a>');
  });

  it('userRef without a username never renders @null', () => {
    const ref = userRef({ tgUsername: null, username: null, displayName: 'Маша <3', telegramId: null, id: 'abc' });
    expect(ref).not.toContain('@null');
    expect(ref).toBe('Маша &lt;3');
  });

  it('userRef falls back to the short id', () => {
    expect(userRef({ id: '0198a1b2-c3d4-7000' })).toBe('user 0198a1b2');
  });

  it('fmtMoney', () => {
    expect(fmtMoney(1490.0, 'RUB')).toBe('1 490 ₽');
    expect(fmtMoney(150, 'XTR')).toBe('150 ⭐');
    expect(fmtMoney(9.5, 'USD')).toBe('9.50 $');
  });

  it('fmtMoneyMap never sums currencies', () => {
    expect(fmtMoneyMap({ XTR: 50.0, RUB: 399.0 })).toBe('399 ₽ + 50 ⭐');
    expect(fmtMoneyMap({})).toBe('0');
  });

  it.each([
    [112, 100, '▲12%'],
    [95, 100, '▼5%'],
    [100, 100, '='],
    [3, 0, 'new'],
    [0, 0, '='],
  ])('fmtDelta(%d, %d) = %s', (current, previous, expected) => {
    expect(fmtDelta(current, previous)).toBe(expected);
  });

  it('bulletList truncates', () => {
    const out = bulletList(['0', '1', '2', '3', '4'], 2);
    expect(out.split('\n')).toEqual(['• 0', '• 1', '<i>…and 3 more</i>']);
  });

  it('tags are valid telegram hashtags', () => {
    expect(tags('purchase', 'u_anna.k-1', '')).toBe('#purchase #u_anna_k_1');
  });

  it('userTag prefers the handle, then the short id', () => {
    expect(userTag({ tgUsername: 'anna', username: 'x' })).toBe('u_anna');
    expect(userTag({ tgUsername: null, username: null, id: '0198a1b2-c3d4' })).toBe('u_0198a1b2');
  });

  it('htmlToPlain', () => {
    expect(htmlToPlain('<b>Hi</b> <a href="x">@a</a> &lt;3<br>bye')).toBe('Hi @a <3\nbye');
  });
});

describe('sendAdminMessage', () => {
  it('prefers the rich body', async () => {
    const bot = new FakeBot();
    const sent = await sendAdminMessage(bot.asBot(), '<b>fallback</b>', {
      richHtml: '<h3>rich</h3>',
      chatIds: [1],
      silent: true,
    });

    expect(sent).toBe(1);
    expect(bot.rich).toEqual([{ chat_id: 1, html: '<h3>rich</h3>', disable_notification: true }]);
    expect(bot.sent).toEqual([]);
  });

  it('falls back to html when the rich body is rejected', async () => {
    const bot = new FakeBot();
    bot.richError = badRequest('rich messages are not supported');
    const sent = await sendAdminMessage(bot.asBot(), '<b>fallback</b>', { richHtml: '<h3>rich</h3>', chatIds: [1] });

    expect(sent).toBe(1);
    expect(bot.sent[0]?.text).toBe('<b>fallback</b>');
    expect(bot.sent[0]?.parse_mode).toBe('HTML');
  });

  it('falls back to plain text when the html is rejected', async () => {
    const bot = new FakeBot();
    bot.htmlError = badRequest();
    const sent = await sendAdminMessage(bot.asBot(), '<b>Purchase</b> &lt;3', { chatIds: [1] });

    expect(sent).toBe(1);
    expect(bot.sent).toEqual([{ chat_id: 1, text: 'Purchase <3', parse_mode: undefined, disable_notification: false }]);
  });

  it('one failing admin does not block the others', async () => {
    const bot = new FakeBot();
    bot.failChat = 2;
    const sent = await sendAdminMessage(bot.asBot(), 'hi', { chatIds: [1, 2, 3] });

    expect(sent).toBe(2);
    expect(bot.sent.map((m) => m.chat_id)).toEqual([1, 3]);
  });

  describe('defaults', () => {
    const owners = settings.rbac.ownerIds;
    afterEach(() => {
      settings.rbac.ownerIds = owners;
    });

    it('goes to all owners', async () => {
      settings.rbac.ownerIds = [7, 8];
      const bot = new FakeBot();
      const sent = await sendAdminMessage(bot.asBot(), 'hi');

      expect(sent).toBe(2);
      expect(new Set(bot.sent.map((m) => m.chat_id))).toEqual(new Set([7, 8]));
    });
  });
});

describe('announceStart and alertOwners', () => {
  const original = { debug: settings.debug, appName: settings.appName, owners: settings.rbac.ownerIds };

  beforeEach(() => {
    settings.appName = 'myapp';
    settings.rbac.ownerIds = [7, 8];
  });
  afterEach(() => {
    settings.debug = original.debug;
    settings.appName = original.appName;
    settings.rbac.ownerIds = original.owners;
    vi.restoreAllMocks();
  });

  it('announces a prod start silently to every owner', async () => {
    settings.debug = false;
    const bot = new FakeBot();
    await announceStart('worker', '1.2.0', bot.asBot());

    expect(new Set(bot.sent.map((m) => m.chat_id))).toEqual(new Set([7, 8]));
    const text = bot.sent[0]?.text ?? '';
    expect(text).toContain('myapp 1.2.0');
    expect(text).toContain('worker started');
    expect(text).toContain('#deploy');
    expect(bot.sent.every((m) => m.disable_notification === true)).toBe(true);
  });

  it('does not announce a debug start', async () => {
    settings.debug = true;
    const bot = new FakeBot();
    await announceStart('webhook', '1.2.0', bot.asBot());

    expect(bot.sent).toEqual([]);
  });

  it('a telegram failure does not break startup', async () => {
    settings.debug = false;
    const bot = new FakeBot();
    bot.api.sendMessage = async () => {
      throw new Error('telegram down');
    };
    await expect(announceStart('bot', '1.2.0', bot.asBot())).resolves.toBeUndefined();
  });

  it('a prod alert reaches every owner with sound', async () => {
    settings.debug = false;
    const bot = new FakeBot();
    shared.bot = bot;
    await alertOwners('🚨 webhook failed');

    expect(new Set(bot.sent.map((m) => m.chat_id))).toEqual(new Set([7, 8]));
    expect(bot.sent.every((m) => m.disable_notification === false)).toBe(true);
  });

  it('alerts reuse the one shared bot', async () => {
    settings.debug = false;
    const bot = new FakeBot();
    shared.bot = bot;
    shared.calls = 0;
    await alertOwners('🚨 one');
    await alertOwners('🚨 two');
    await announceStart('webhook', '1.2.0');

    expect(bot.sent).toHaveLength(6);
    expect(new Set(bot.sent.map((m) => m.text)).size).toBe(3);
  });

  it('debug sends nothing and never asks for the shared bot', async () => {
    settings.debug = true;
    shared.calls = 0;
    await alertOwners('🚨 webhook failed');

    expect(shared.calls).toBe(0);
  });
});
