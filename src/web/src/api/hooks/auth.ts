import { json, useApiMutation, type MutationHookOptions } from '../query';
import { authApi, telegramLinkApi } from '../clients';
import type { JsonOf, Ok } from '../types';

type Post = (...args: never[]) => unknown;
type Vars<E extends Post> = { data: JsonOf<E> };

export function useCheckEmail<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof authApi.email.check.$post>, Vars<typeof authApi.email.check.$post>, TContext> = {},
) {
  return useApiMutation(({ data }: Vars<typeof authApi.email.check.$post>) => json(authApi.email.check.$post({ json: data })), options);
}

export function useLoginEmail<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof authApi.login.email.$post>, Vars<typeof authApi.login.email.$post>, TContext> = {},
) {
  return useApiMutation(({ data }: Vars<typeof authApi.login.email.$post>) => json(authApi.login.email.$post({ json: data })), options);
}

export function useStartEmailSignup<TContext = unknown>(
  options: MutationHookOptions<
    Ok<typeof authApi.signup.email.start.$post>,
    Vars<typeof authApi.signup.email.start.$post>,
    TContext
  > = {},
) {
  return useApiMutation(
    ({ data }: Vars<typeof authApi.signup.email.start.$post>) => json(authApi.signup.email.start.$post({ json: data })),
    options,
  );
}

export function useCompleteEmailSignup<TContext = unknown>(
  options: MutationHookOptions<
    Ok<typeof authApi.signup.email.complete.$post>,
    Vars<typeof authApi.signup.email.complete.$post>,
    TContext
  > = {},
) {
  return useApiMutation(
    ({ data }: Vars<typeof authApi.signup.email.complete.$post>) =>
      json(authApi.signup.email.complete.$post({ json: data })),
    options,
  );
}

export function useResendSignupCode<TContext = unknown>(
  options: MutationHookOptions<
    Ok<typeof authApi.signup.email.resend.$post>,
    Vars<typeof authApi.signup.email.resend.$post>,
    TContext
  > = {},
) {
  return useApiMutation(
    ({ data }: Vars<typeof authApi.signup.email.resend.$post>) => json(authApi.signup.email.resend.$post({ json: data })),
    options,
  );
}

export function useStartEmailLink<TContext = unknown>(
  options: MutationHookOptions<
    Ok<typeof authApi.link.email.start.$post>,
    Vars<typeof authApi.link.email.start.$post>,
    TContext
  > = {},
) {
  return useApiMutation(
    ({ data }: Vars<typeof authApi.link.email.start.$post>) => json(authApi.link.email.start.$post({ json: data })),
    options,
  );
}

export function useCompleteEmailLink<TContext = unknown>(
  options: MutationHookOptions<
    Ok<typeof authApi.link.email.complete.$post>,
    Vars<typeof authApi.link.email.complete.$post>,
    TContext
  > = {},
) {
  return useApiMutation(
    ({ data }: Vars<typeof authApi.link.email.complete.$post>) => json(authApi.link.email.complete.$post({ json: data })),
    options,
  );
}

export function useStartPasswordReset<TContext = unknown>(
  options: MutationHookOptions<
    Ok<typeof authApi.password.reset.start.$post>,
    Vars<typeof authApi.password.reset.start.$post>,
    TContext
  > = {},
) {
  return useApiMutation(
    ({ data }: Vars<typeof authApi.password.reset.start.$post>) =>
      json(authApi.password.reset.start.$post({ json: data })),
    options,
  );
}

export function useCompletePasswordReset<TContext = unknown>(
  options: MutationHookOptions<
    Ok<typeof authApi.password.reset.complete.$post>,
    Vars<typeof authApi.password.reset.complete.$post>,
    TContext
  > = {},
) {
  return useApiMutation(
    ({ data }: Vars<typeof authApi.password.reset.complete.$post>) =>
      json(authApi.password.reset.complete.$post({ json: data })),
    options,
  );
}

// ── Telegram: deep-link login (logged out) and account linking (logged in) ──

export const startTelegramDeeplinkLogin = () => json(authApi.login.telegram.deeplink.start.$post());
export const pollTelegramDeeplinkLogin = (token: string) =>
  json(authApi.login.telegram.deeplink.poll.$get({ query: { token } }));

export const startTelegramLink = () => json(telegramLinkApi.start.$post());
export const pollTelegramLink = (token: string) => json(telegramLinkApi.poll.$get({ query: { token } }));

export function useStartTelegramLink<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof telegramLinkApi.start.$post>, void, TContext> = {},
) {
  return useApiMutation(startTelegramLink, options);
}
