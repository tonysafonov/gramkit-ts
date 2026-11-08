import type { Context, SessionFlavor } from 'grammy';
import type { UserSchema } from '../modules/users/schemas';
import type { Repos } from '../repos';
import type { Services } from '../services';

/**
 * The FSM state of a chat+user (aiogram's `FSMContext`): a state name and the data collected so far. Kept in Redis
 * by `RedisSessionStorage`; `state` is `undefined` outside a flow.
 */
export interface BotSession {
  state?: string;
  data: Record<string, unknown>;
}

/** What the middleware chain puts on a bot update (aiogram's handler `data`). One transaction per update. */
interface BotFlavor {
  repos: Repos;
  services: Services;
  /** Set by `authMiddleware`; absent for updates that never create a user and for `/start link_*`. */
  user?: UserSchema;
}

export type BotContext = Context & SessionFlavor<BotSession> & BotFlavor;
