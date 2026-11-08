import { toValue, type MaybeRefOrGetter } from 'vue';
import {
  json,
  queryKey,
  reactiveKey,
  useApiMutation,
  useApiQuery,
  wireQuery,
  type LooseQuery,
  type MutationHookOptions,
  type QueryHookOptions,
} from '../query';
import {
  adminApi,
  adminTasksApi,
  analyticsApi,
  auditLogApi,
  broadcastsApi,
  marketingLinksApi,
  statisticsApi,
} from '../clients';
import type { JsonOf, Ok, QueryOf } from '../types';

const signalInit = (signal?: AbortSignal) => ({ init: { signal } });
type Id = number | string;
const str = (id: Id) => String(id);

// ── RBAC meta ───────────────────────────────────────────────────────────────

export const adminRbacKey = () => queryKey('/admin/meta/rbac');
export function useAdminRbac(options: QueryHookOptions<Ok<(typeof adminApi.meta)['rbac']['$get']>> = {}) {
  return useApiQuery(
    { queryKey: adminRbacKey(), queryFn: ({ signal }) => json(adminApi.meta.rbac.$get(undefined, signalInit(signal))) },
    options,
  );
}

// ── Users ───────────────────────────────────────────────────────────────────

type UsersQuery = LooseQuery<QueryOf<typeof adminApi.users.$get>>;
export const listUsersKey = (params?: UsersQuery) => queryKey('/admin/users', undefined, params);
export function useListUsers(
  params: MaybeRefOrGetter<UsersQuery>,
  options: QueryHookOptions<Ok<typeof adminApi.users.$get>> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/admin/users', undefined, params),
      queryFn: ({ signal }) => json(adminApi.users.$get({ query: wireQuery(toValue(params)) }, signalInit(signal))),
    },
    options,
  );
}

const user = adminApi.users[':user_id'];

export function useUserDetail(userId: MaybeRefOrGetter<Id>, options: QueryHookOptions<Ok<typeof user.$get>> = {}) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/admin/users/:user_id', { user_id: userId }),
      queryFn: ({ signal }) => json(user.$get({ param: { user_id: str(toValue(userId)) } }, signalInit(signal))),
    },
    options,
  );
}

type UserPaymentsQuery = LooseQuery<QueryOf<typeof user.payments.$get>>;
export function useListUserPayments(
  userId: MaybeRefOrGetter<Id>,
  params: MaybeRefOrGetter<UserPaymentsQuery>,
  options: QueryHookOptions<Ok<typeof user.payments.$get>> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/admin/users/:user_id/payments', { user_id: userId }, params),
      queryFn: ({ signal }) =>
        json(
          user.payments.$get(
            { param: { user_id: str(toValue(userId)) }, query: wireQuery(toValue(params)) },
            signalInit(signal),
          ),
        ),
    },
    options,
  );
}

export function useListUserSubscriptions(
  userId: MaybeRefOrGetter<Id>,
  options: QueryHookOptions<Ok<typeof user.subscriptions.$get>> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/admin/users/:user_id/subscriptions', { user_id: userId }),
      queryFn: ({ signal }) =>
        json(user.subscriptions.$get({ param: { user_id: str(toValue(userId)) } }, signalInit(signal))),
    },
    options,
  );
}

type UserVars<E extends (...args: never[]) => unknown> = { user_id: Id; data: JsonOf<E> };

export function useGiftUserSubscription<TContext = unknown>(
  options: MutationHookOptions<
    Ok<(typeof user)['gift-subscription']['$post']>,
    UserVars<(typeof user)['gift-subscription']['$post']>,
    TContext
  > = {},
) {
  return useApiMutation(
    ({ user_id, data }: UserVars<(typeof user)['gift-subscription']['$post']>) =>
      json(user['gift-subscription'].$post({ param: { user_id: str(user_id) }, json: data })),
    options,
  );
}

export function useRevokeUserSubscription<TContext = unknown>(
  options: MutationHookOptions<Ok<(typeof user)['revoke-subscription']['$post']>, { user_id: Id }, TContext> = {},
) {
  return useApiMutation(
    ({ user_id }: { user_id: Id }) => json(user['revoke-subscription'].$post({ param: { user_id: str(user_id) } })),
    options,
  );
}

export function useChangeUserRole<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof user.role.$post>, UserVars<typeof user.role.$post>, TContext> = {},
) {
  return useApiMutation(
    ({ user_id, data }: UserVars<typeof user.role.$post>) =>
      json(user.role.$post({ param: { user_id: str(user_id) }, json: data })),
    options,
  );
}

export function useResetUserData<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof user.reset.$post>, { user_id: Id }, TContext> = {},
) {
  return useApiMutation(
    ({ user_id }: { user_id: Id }) => json(user.reset.$post({ param: { user_id: str(user_id) } })),
    options,
  );
}

export function useRefundPayment<TContext = unknown>(
  options: MutationHookOptions<
    Ok<(typeof adminApi.payments)[':payment_id']['refund']['$post']>,
    { payment_id: Id },
    TContext
  > = {},
) {
  return useApiMutation(
    ({ payment_id }: { payment_id: Id }) =>
      json(adminApi.payments[':payment_id'].refund.$post({ param: { payment_id: str(payment_id) } })),
    options,
  );
}

// ── Audit log ───────────────────────────────────────────────────────────────

type AuditQuery = LooseQuery<QueryOf<(typeof auditLogApi)['audit-log']['$get']>>;
export const listAuditLogKey = (params?: AuditQuery) => queryKey('/admin/audit-log', undefined, params);
export const listAuditActionsKey = () => queryKey('/admin/audit-log/actions');

export function useListAuditLog(
  params: MaybeRefOrGetter<AuditQuery>,
  options: QueryHookOptions<Ok<(typeof auditLogApi)['audit-log']['$get']>> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/admin/audit-log', undefined, params),
      queryFn: ({ signal }) =>
        json(auditLogApi['audit-log'].$get({ query: wireQuery(toValue(params)) }, signalInit(signal))),
    },
    options,
  );
}

export function useListAuditActions(
  options: QueryHookOptions<Ok<(typeof auditLogApi)['audit-log']['actions']['$get']>> = {},
) {
  return useApiQuery(
    {
      queryKey: listAuditActionsKey(),
      queryFn: ({ signal }) => json(auditLogApi['audit-log'].actions.$get(undefined, signalInit(signal))),
    },
    options,
  );
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export function useListTasks(options: QueryHookOptions<Ok<typeof adminTasksApi.tasks.$get>> = {}) {
  return useApiQuery(
    {
      queryKey: queryKey('/admin/tasks'),
      queryFn: ({ signal }) => json(adminTasksApi.tasks.$get(undefined, signalInit(signal))),
    },
    options,
  );
}

type RunTaskVars = { name: string; data: JsonOf<(typeof adminTasksApi.tasks)[':name']['$post']> };
export function useRunTask<TContext = unknown>(
  options: MutationHookOptions<Ok<(typeof adminTasksApi.tasks)[':name']['$post']>, RunTaskVars, TContext> = {},
) {
  return useApiMutation(
    ({ name, data }: RunTaskVars) => json(adminTasksApi.tasks[':name'].$post({ param: { name }, json: data })),
    options,
  );
}

// ── Marketing links ─────────────────────────────────────────────────────────

const links = marketingLinksApi['marketing-links'];
export const listMarketingLinksKey = () => queryKey('/admin/marketing-links');

export function useListMarketingLinks(options: QueryHookOptions<Ok<typeof links.$get>> = {}) {
  return useApiQuery(
    { queryKey: listMarketingLinksKey(), queryFn: ({ signal }) => json(links.$get(undefined, signalInit(signal))) },
    options,
  );
}

type CreateLinkVars = { data: JsonOf<typeof links.$post> };
export function useCreateMarketingLink<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof links.$post>, CreateLinkVars, TContext> = {},
) {
  return useApiMutation(({ data }: CreateLinkVars) => json(links.$post({ json: data })), options);
}

type UpdateLinkVars = { link_id: Id; data: JsonOf<(typeof links)[':link_id']['$patch']> };
export function useUpdateMarketingLink<TContext = unknown>(
  options: MutationHookOptions<Ok<(typeof links)[':link_id']['$patch']>, UpdateLinkVars, TContext> = {},
) {
  return useApiMutation(
    ({ link_id, data }: UpdateLinkVars) => json(links[':link_id'].$patch({ param: { link_id: str(link_id) }, json: data })),
    options,
  );
}

// ── Statistics and analytics ────────────────────────────────────────────────

export function useStatisticsOverview(options: QueryHookOptions<Ok<typeof statisticsApi.statistics.overview.$get>> = {}) {
  return useApiQuery(
    {
      queryKey: queryKey('/admin/statistics/overview'),
      queryFn: ({ signal }) => json(statisticsApi.statistics.overview.$get(undefined, signalInit(signal))),
    },
    options,
  );
}

type RevenueQuery = LooseQuery<QueryOf<(typeof analyticsApi.analytics)['revenue-timeseries']['$get']>>;
export function useRevenueTimeseries(
  params: MaybeRefOrGetter<RevenueQuery>,
  options: QueryHookOptions<Ok<(typeof analyticsApi.analytics)['revenue-timeseries']['$get']>> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/admin/analytics/revenue-timeseries', undefined, params),
      queryFn: ({ signal }) =>
        json(
          analyticsApi.analytics['revenue-timeseries'].$get({ query: wireQuery(toValue(params)) }, signalInit(signal)),
        ),
    },
    options,
  );
}

export function useRevenueKpis(options: QueryHookOptions<Ok<(typeof analyticsApi.analytics)['revenue-kpis']['$get']>> = {}) {
  return useApiQuery(
    {
      queryKey: queryKey('/admin/analytics/revenue-kpis'),
      queryFn: ({ signal }) => json(analyticsApi.analytics['revenue-kpis'].$get(undefined, signalInit(signal))),
    },
    options,
  );
}

type TrendQuery = LooseQuery<QueryOf<(typeof analyticsApi.analytics)['subscription-trend']['$get']>>;
export function useSubscriptionTrend(
  params: MaybeRefOrGetter<TrendQuery>,
  options: QueryHookOptions<Ok<(typeof analyticsApi.analytics)['subscription-trend']['$get']>> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/admin/analytics/subscription-trend', undefined, params),
      queryFn: ({ signal }) =>
        json(
          analyticsApi.analytics['subscription-trend'].$get({ query: wireQuery(toValue(params)) }, signalInit(signal)),
        ),
    },
    options,
  );
}

export function useSubscriptionBreakdown(
  options: QueryHookOptions<Ok<(typeof analyticsApi.analytics)['subscription-breakdown']['$get']>> = {},
) {
  return useApiQuery(
    {
      queryKey: queryKey('/admin/analytics/subscription-breakdown'),
      queryFn: ({ signal }) => json(analyticsApi.analytics['subscription-breakdown'].$get(undefined, signalInit(signal))),
    },
    options,
  );
}

export function useMrr(options: QueryHookOptions<Ok<typeof analyticsApi.analytics.mrr.$get>> = {}) {
  return useApiQuery(
    {
      queryKey: queryKey('/admin/analytics/mrr'),
      queryFn: ({ signal }) => json(analyticsApi.analytics.mrr.$get(undefined, signalInit(signal))),
    },
    options,
  );
}

// ── Broadcasts ──────────────────────────────────────────────────────────────

const broadcasts = broadcastsApi.broadcasts;
export const listBroadcastsKey = () => queryKey('/admin/broadcasts');
export const broadcastKey = (broadcastId: Id) => queryKey('/admin/broadcasts/:broadcast_id', { broadcast_id: broadcastId });

export function useListBroadcasts(options: QueryHookOptions<Ok<typeof broadcasts.$get>> = {}) {
  return useApiQuery(
    { queryKey: listBroadcastsKey(), queryFn: ({ signal }) => json(broadcasts.$get(undefined, signalInit(signal))) },
    options,
  );
}

export function useGetBroadcast(
  broadcastId: MaybeRefOrGetter<Id>,
  options: QueryHookOptions<Ok<(typeof broadcasts)[':broadcast_id']['$get']>> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/admin/broadcasts/:broadcast_id', { broadcast_id: broadcastId }),
      queryFn: ({ signal }) =>
        json(broadcasts[':broadcast_id'].$get({ param: { broadcast_id: str(toValue(broadcastId)) } }, signalInit(signal))),
    },
    options,
  );
}

type CreateBroadcastVars = { data: JsonOf<typeof broadcasts.$post> };
export function useCreateBroadcast<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof broadcasts.$post>, CreateBroadcastVars, TContext> = {},
) {
  return useApiMutation(({ data }: CreateBroadcastVars) => json(broadcasts.$post({ json: data })), options);
}

type EditBroadcastVars = { broadcast_id: Id; data: JsonOf<(typeof broadcasts)[':broadcast_id']['$patch']> };
export function useEditBroadcast<TContext = unknown>(
  options: MutationHookOptions<Ok<(typeof broadcasts)[':broadcast_id']['$patch']>, EditBroadcastVars, TContext> = {},
) {
  return useApiMutation(
    ({ broadcast_id, data }: EditBroadcastVars) =>
      json(broadcasts[':broadcast_id'].$patch({ param: { broadcast_id: str(broadcast_id) }, json: data })),
    options,
  );
}

export function useCancelBroadcast<TContext = unknown>(
  options: MutationHookOptions<Ok<(typeof broadcasts)[':broadcast_id']['cancel']['$post']>, { broadcast_id: Id }, TContext> = {},
) {
  return useApiMutation(
    ({ broadcast_id }: { broadcast_id: Id }) =>
      json(broadcasts[':broadcast_id'].cancel.$post({ param: { broadcast_id: str(broadcast_id) } })),
    options,
  );
}

type SendNowVars = { data: JsonOf<typeof broadcasts['send-now']['$post']> };
export function useSendBroadcastNow<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof broadcasts['send-now']['$post']>, SendNowVars, TContext> = {},
) {
  return useApiMutation(({ data }: SendNowVars) => json(broadcasts['send-now'].$post({ json: data })), options);
}

type PreviewVars = { data: JsonOf<typeof broadcasts.preview.$post> };
export function usePreviewBroadcast<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof broadcasts.preview.$post>, PreviewVars, TContext> = {},
) {
  return useApiMutation(({ data }: PreviewVars) => json(broadcasts.preview.$post({ json: data })), options);
}
