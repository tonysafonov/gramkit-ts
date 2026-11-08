import type { BotContext } from './context';

/** aiogram's `FSMContext` over the session: the state name, and the data collected in the flow. */
export const setState = (ctx: BotContext, state: string): void => {
  ctx.session.state = state;
};

export const inState =
  (state: string) =>
  (ctx: BotContext): boolean =>
    ctx.session?.state === state;

export const updateData = (ctx: BotContext, data: Record<string, unknown>): void => {
  ctx.session.data = { ...ctx.session.data, ...data };
};

export const getData = (ctx: BotContext): Record<string, unknown> => ctx.session.data;

/** Leave the flow and drop its data. */
export const clearState = (ctx: BotContext): void => {
  ctx.session = { data: {} };
};
