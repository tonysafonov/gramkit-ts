import { toValue, type MaybeRefOrGetter } from 'vue';
import { queryOptions } from '@tanstack/vue-query';
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
import { API_BASE_URL, apiClientFetch } from '@core/api';
import { demoApi } from '../clients';
import type { CounterResponse, JsonOf, Ok, QueryOf } from '../types';

const signalInit = (signal?: AbortSignal) => ({ init: { signal } });

// ── Counter ─────────────────────────────────────────────────────────────────

type CounterParams = LooseQuery<QueryOf<typeof demoApi.counter.$get>>;
export const counterKey = (params?: CounterParams) => queryKey('/demo/counter', undefined, params);

export function useCounter<TData = CounterResponse>(
  params: MaybeRefOrGetter<CounterParams>,
  options: QueryHookOptions<CounterResponse, TData> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/demo/counter', undefined, params),
      queryFn: ({ signal }) => json(demoApi.counter.$get({ query: wireQuery(toValue(params)) }, signalInit(signal))),
    },
    options,
  );
}

type IncrementVars = { params: LooseQuery<QueryOf<typeof demoApi.counter.increment.$post>> };
export function useIncrementCounter<TContext = unknown>(
  options: MutationHookOptions<CounterResponse, IncrementVars, TContext> = {},
) {
  return useApiMutation(({ params }: IncrementVars) => json(demoApi.counter.increment.$post({ query: wireQuery(params) })), options);
}

type ResetVars = { params: LooseQuery<QueryOf<typeof demoApi.counter.reset.$post>> };
export function useResetCounter<TContext = unknown>(options: MutationHookOptions<CounterResponse, ResetVars, TContext> = {}) {
  return useApiMutation(({ params }: ResetVars) => json(demoApi.counter.reset.$post({ query: wireQuery(params) })), options);
}

// ── Simple reads ────────────────────────────────────────────────────────────

export const serverTimeKey = () => queryKey('/demo/time');
export const fetchServerTime = (signal?: AbortSignal) => json(demoApi.time.$get(undefined, signalInit(signal)));
export function useServerTime(options: QueryHookOptions<Ok<typeof demoApi.time.$get>> = {}) {
  return useApiQuery({ queryKey: serverTimeKey(), queryFn: ({ signal }) => fetchServerTime(signal) }, options);
}

export function useSlowEndpoint(
  params: MaybeRefOrGetter<LooseQuery<QueryOf<typeof demoApi.slow.$get>>>,
  options: QueryHookOptions<Ok<typeof demoApi.slow.$get>> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/demo/slow', undefined, params),
      queryFn: ({ signal }) => json(demoApi.slow.$get({ query: wireQuery(toValue(params)) }, signalInit(signal))),
    },
    options,
  );
}

export function useUnreliableEndpoint(
  params: MaybeRefOrGetter<LooseQuery<QueryOf<typeof demoApi.unreliable.$get>>>,
  options: QueryHookOptions<Ok<typeof demoApi.unreliable.$get>> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/demo/unreliable', undefined, params),
      queryFn: ({ signal }) => json(demoApi.unreliable.$get({ query: wireQuery(toValue(params)) }, signalInit(signal))),
    },
    options,
  );
}

/**
 * `GET /demo/error/{status_code}`: always answers with that error status. The handler never returns, so Hono infers no
 * response for it and `hc` has no entry for the route: this goes through the same fetch the clients use.
 */
export const triggerDemoError = async (statusCode: number): Promise<void> => {
  await apiClientFetch(`${API_BASE_URL}/demo/error/${statusCode}`);
};

// ── Items ───────────────────────────────────────────────────────────────────

export const fetchPaginatedItems = (query: LooseQuery<QueryOf<typeof demoApi.items.$get>>) =>
  json(demoApi.items.$get({ query: wireQuery(query) }));

type ItemQuery = LooseQuery<QueryOf<(typeof demoApi.items)[':item_id']['$get']>>;
export const itemDetailQueryOptions = (itemId: number, params: ItemQuery) =>
  queryOptions({
    queryKey: queryKey('/demo/items/:item_id', { item_id: itemId }, params),
    queryFn: ({ signal }) =>
      json(demoApi.items[':item_id'].$get({ param: { item_id: String(itemId) }, query: wireQuery(params) }, signalInit(signal))),
  });

export function useItemDetail(
  itemId: MaybeRefOrGetter<number>,
  params: MaybeRefOrGetter<ItemQuery>,
  options: QueryHookOptions<Ok<(typeof demoApi.items)[':item_id']['$get']>> = {},
) {
  return useApiQuery(
    {
      queryKey: reactiveKey('/demo/items/:item_id', { item_id: itemId }, params),
      queryFn: ({ signal }) =>
        json(
          demoApi.items[':item_id'].$get(
            { param: { item_id: String(toValue(itemId)) }, query: wireQuery(toValue(params)) },
            signalInit(signal),
          ),
        ),
    },
    options,
  );
}

export const weatherQueryOptions = (params: LooseQuery<QueryOf<typeof demoApi.weather.$get>>) =>
  queryOptions({
    queryKey: queryKey('/demo/weather', undefined, params),
    queryFn: ({ signal }) => json(demoApi.weather.$get({ query: wireQuery(params) }, signalInit(signal))),
  });

export const stockQueryOptions = (params: LooseQuery<QueryOf<typeof demoApi.stock.$get>>) =>
  queryOptions({
    queryKey: queryKey('/demo/stock', undefined, params),
    queryFn: ({ signal }) => json(demoApi.stock.$get({ query: wireQuery(params) }, signalInit(signal))),
  });

export const newsQueryOptions = (params: LooseQuery<QueryOf<typeof demoApi.news.$get>>) =>
  queryOptions({
    queryKey: queryKey('/demo/news', undefined, params),
    queryFn: ({ signal }) => json(demoApi.news.$get({ query: wireQuery(params) }, signalInit(signal))),
  });

// ── Notification and RBAC demos ─────────────────────────────────────────────

type NotifyVars = { data: JsonOf<typeof demoApi.notify.$post> };
export function useScheduleNotification<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof demoApi.notify.$post>, NotifyVars, TContext> = {},
) {
  return useApiMutation(({ data }: NotifyVars) => json(demoApi.notify.$post({ json: data })), options);
}

export const rbacMeKey = () => queryKey('/demo/rbac/me');
export function useRbacMe(options: QueryHookOptions<Ok<typeof demoApi.rbac.me.$get>> = {}) {
  return useApiQuery(
    { queryKey: rbacMeKey(), queryFn: ({ signal }) => json(demoApi.rbac.me.$get(undefined, signalInit(signal))) },
    options,
  );
}

type SetRoleVars = { data: JsonOf<typeof demoApi.rbac['set-role']['$post']> };
export function useSetDemoRole<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof demoApi.rbac['set-role']['$post']>, SetRoleVars, TContext> = {},
) {
  return useApiMutation(({ data }: SetRoleVars) => json(demoApi.rbac['set-role'].$post({ json: data })), options);
}

export function useDemoProtectedAction<TContext = unknown>(
  options: MutationHookOptions<Ok<typeof demoApi.rbac['protected-action']['$post']>, void, TContext> = {},
) {
  return useApiMutation(() => json(demoApi.rbac['protected-action'].$post()), options);
}
