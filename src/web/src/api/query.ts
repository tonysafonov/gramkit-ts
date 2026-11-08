/**
 * Glue between the `hc` clients and TanStack Query.
 *
 * - `json(call)`: the typed success body of an `hc` call. `apiClientFetch` throws on non-2xx, so the body type is the
 *   success one (`InferResponseType`'s 2xx members).
 * - `queryKey(url, ...)`: keys keep the shape the Kubb hooks used, `[{ url, params? }, query?]`, so prefix matching on
 *   `{ url }` (`invalidateQueries`, predicates) still works.
 * - `useApiQuery` / `useApiMutation`: the two composables every hook in `./hooks` is built on.
 */
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import {
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/vue-query';
import type { ClientResponse } from 'hono/client';
import type { ApiError } from '@core/errors';

type SuccessStatus = 200 | 201 | 202 | 204;

/** The JSON body type of the success responses of an `hc` call. */
export type SuccessBody<R> = R extends ClientResponse<infer Body, infer Status, 'json'>
  ? Status extends SuccessStatus
    ? Body
    : never
  : never;

/** Await an `hc` call and return its JSON body, typed from the server's route. */
export async function json<R extends ClientResponse<unknown, number, string>>(call: Promise<R>): Promise<SuccessBody<R>> {
  const response = await call;
  return (await response.json()) as SuccessBody<R>;
}

/** Like `json`, for the 204/empty-body routes: only waits for success. */
export async function done(call: Promise<ClientResponse<unknown, number, string>>): Promise<void> {
  await call;
}

type KeyPart = Record<string, unknown>;

/** `[{ url }]`, `[{ url, params: pathParams }]`, plus the query params when there are some. */
export function queryKey(url: string, pathParams?: KeyPart, query?: KeyPart): QueryKey {
  const head = pathParams ? { url, params: pathParams } : { url };
  return query ? [head, query] : [head];
}

/** `queryKey` for hooks whose arguments may be refs or getters. */
export function reactiveKey(
  url: string,
  pathParams?: Record<string, MaybeRefOrGetter<unknown>>,
  query?: MaybeRefOrGetter<KeyPart | undefined>,
) {
  return computed(() => {
    const resolved = pathParams
      ? Object.fromEntries(Object.entries(pathParams).map(([name, value]) => [name, toValue(value)]))
      : undefined;
    return queryKey(url, resolved, toValue(query));
  });
}

/** What a query hook accepts as its last argument, as the Kubb hooks did: `{ query: { staleTime, enabled, ... } }`. */
export interface QueryHookOptions<TData, TSelected = TData> {
  query?: Partial<UseQueryOptions<TData, ApiError, TSelected, TData, QueryKey>>;
}

/** What a mutation hook accepts: `{ mutation: { onSuccess, onMutate, ... } }`. */
export interface MutationHookOptions<TData, TVariables, TContext> {
  mutation?: UseMutationOptions<TData, ApiError, TVariables, TContext>;
}

export function useApiQuery<TData, TSelected = TData>(
  base: {
    queryKey: MaybeRefOrGetter<QueryKey>;
    queryFn: (context: { signal: AbortSignal }) => Promise<TData>;
  },
  options: QueryHookOptions<TData, TSelected> = {},
) {
  const query = useQuery({
    ...base,
    ...options.query,
    queryKey: base.queryKey,
  } as UseQueryOptions<TData, ApiError, TSelected, TData, QueryKey>);
  return Object.assign(query, { queryKey: base.queryKey });
}

export function useApiMutation<TData, TVariables = void, TContext = unknown>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: MutationHookOptions<TData, TVariables, TContext> = {},
) {
  return useMutation<TData, ApiError, TVariables, TContext>({ mutationFn, ...options.mutation });
}

/** What a list hook takes as query params: the route's keys, with numbers/booleans/nulls allowed (nulls are dropped). */
export type LooseQuery<Q> = { [K in keyof Q]?: Q[K] | number | boolean | null };

/**
 * Query params for the wire: `hc` sends strings. Null, undefined and empty values are dropped, so an absent filter
 * means "no filter" (the axios client dropped them the same way).
 */
export function wireQuery<Q>(query: LooseQuery<Q> | undefined): Q {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    out[name] = String(value);
  }
  return out as Q;
}
