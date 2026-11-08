/**
 * Request and response types, inferred from the server's routes through the `hc` clients. Nothing here is written by
 * hand: a type follows the route it comes from.
 */
import type { InferRequestType, InferResponseType } from 'hono/client';
import type {
  adminApi,
  adminTasksApi,
  auditLogApi,
  broadcastsApi,
  demoApi,
  marketingLinksApi,
  startApi,
  telegramLinkApi,
  usersApi,
} from './clients';

/** The JSON body a route takes. */
export type JsonOf<E extends (...args: never[]) => unknown> = InferRequestType<E> extends { json: infer J } ? J : never;
/** The query params a route takes. */
export type QueryOf<E extends (...args: never[]) => unknown> = InferRequestType<E> extends { query: infer Q }
  ? Q
  : never;
/** A route's 200 body. */
export type Ok<E extends (...args: never[]) => unknown> = InferResponseType<E, 200>;

// Users
export type UserSchema = Ok<typeof usersApi.me.$get>;
export type UpdateUserBody = JsonOf<typeof usersApi.me.$patch>;

// Start
export type StartData = Ok<typeof startApi.process_start.$post>;
export type StartMode = NonNullable<JsonOf<typeof startApi.process_start.$post>['mode']>;

// Telegram link
export type TelegramLinkStatusResponse = Ok<typeof telegramLinkApi.poll.$get>;

// Demo
export type CounterResponse = Ok<typeof demoApi.counter.$get>;
export type PaginatedResponse = Ok<typeof demoApi.items.$get>;

// Admin
export type AdminUserListItem = Ok<typeof adminApi.users.$get>['items'][number];
export type AdminUserDetail = Ok<(typeof adminApi.users)[':user_id']['$get']>;
export type AdminUserSubscription = Ok<(typeof adminApi.users)[':user_id']['subscriptions']['$get']>[number];
export type AdminPaymentListItem = Ok<(typeof adminApi.users)[':user_id']['payments']['$get']>['items'][number];
export type ChangeRoleRequest = JsonOf<(typeof adminApi.users)[':user_id']['role']['$post']>;
export type GiftSubscriptionRequest = JsonOf<(typeof adminApi.users)[':user_id']['gift-subscription']['$post']>;
export type AdminTaskInfo = Ok<typeof adminTasksApi.tasks.$get>[number];
export type AuditLogSchema = Ok<typeof auditLogApi['audit-log']['$get']>['items'][number];
export type BroadcastListItem = Ok<typeof broadcastsApi.broadcasts.$get>['active'][number];
export type BroadcastDetail = Ok<(typeof broadcastsApi.broadcasts)[':broadcast_id']['$get']>;
export type BroadcastDeliveryStats = Ok<(typeof broadcastsApi.broadcasts)[':broadcast_id']['stats']['$get']>;
export type BroadcastMediaUploadResponse = Ok<typeof broadcastsApi.broadcasts.media.$post>;
export type MarketingLinkItem = Ok<typeof marketingLinksApi['marketing-links']['$get']>['items'][number];
