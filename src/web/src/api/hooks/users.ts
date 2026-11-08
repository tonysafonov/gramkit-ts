import { json, queryKey, useApiMutation, useApiQuery, type MutationHookOptions, type QueryHookOptions } from '../query';
import { API_BASE_URL, apiClientFetch } from '@core/api';
import { authApi, friendsApi, invitesApi, startApi, subscriptionsApi, usersApi } from '../clients';
import type { JsonOf, Ok, StartData, UpdateUserBody, UserSchema } from '../types';

// ── Current user ────────────────────────────────────────────────────────────

export const currentUserKey = () => queryKey('/users/me');

export const fetchCurrentUser = (signal?: AbortSignal) => json(usersApi.me.$get(undefined, { init: { signal } }));

export function useCurrentUser<TData = UserSchema>(options: QueryHookOptions<UserSchema, TData> = {}) {
  return useApiQuery({ queryKey: currentUserKey(), queryFn: ({ signal }) => fetchCurrentUser(signal) }, options);
}

export function useUpdateCurrentUser<TContext = unknown>(
  options: MutationHookOptions<UserSchema, { data: UpdateUserBody }, TContext> = {},
) {
  return useApiMutation(({ data }: { data: UpdateUserBody }) => json(usersApi.me.$patch({ json: data })), options);
}

export function useMarkSeenFeatures<TContext = unknown>(
  options: MutationHookOptions<UserSchema, { data: JsonOf<typeof usersApi.me['seen-features']['$patch']> }, TContext> = {},
) {
  return useApiMutation(
    ({ data }: { data: JsonOf<typeof usersApi.me['seen-features']['$patch']> }) =>
      json(usersApi.me['seen-features'].$patch({ json: data })),
    options,
  );
}

// ── Session ─────────────────────────────────────────────────────────────────

export function useLogoutMutation<TContext = unknown>(options: MutationHookOptions<Ok<typeof authApi.logout.$post>, void, TContext> = {}) {
  return useApiMutation(() => json(authApi.logout.$post()), options);
}

/** `POST /process_start`: the app-open call that returns the current user and the start mode. */
export const processStart = (body: JsonOf<typeof startApi.process_start.$post>): Promise<StartData> =>
  json(startApi.process_start.$post({ json: body }));

// ── Subscription, friends, invites ──────────────────────────────────────────

export const subscriptionKey = () => queryKey('/subscriptions/');
type SubscriptionResponse = Ok<typeof subscriptionsApi.subscriptions.index.$get>;
/**
 * `hc` drops the trailing slash of `GET /subscriptions/`, and the server answers the bare path with a redirect to its
 * own absolute URL (which skips the dev proxy and breaks cookies). So the request is made with the slash; the type
 * still comes from the route.
 */
export const fetchSubscription = async (signal?: AbortSignal): Promise<SubscriptionResponse> => {
  const response = await apiClientFetch(`${API_BASE_URL}/subscriptions/`, { signal });
  return (await response.json()) as SubscriptionResponse;
};

export function useSubscription<TData = SubscriptionResponse>(
  options: QueryHookOptions<SubscriptionResponse, TData> = {},
) {
  return useApiQuery({ queryKey: subscriptionKey(), queryFn: ({ signal }) => fetchSubscription(signal) }, options);
}

export const friendsKey = () => queryKey('/friends');
export function useFriends(options: QueryHookOptions<Ok<typeof friendsApi.friends.$get>> = {}) {
  return useApiQuery(
    { queryKey: friendsKey(), queryFn: ({ signal }) => json(friendsApi.friends.$get(undefined, { init: { signal } })) },
    options,
  );
}

export const createInviteKey = () => queryKey('/create_invite');
export function useCreateInvite(options: QueryHookOptions<Ok<typeof invitesApi.create_invite.$get>> = {}) {
  return useApiQuery(
    {
      queryKey: createInviteKey(),
      queryFn: ({ signal }) => json(invitesApi.create_invite.$get(undefined, { init: { signal } })),
    },
    options,
  );
}
