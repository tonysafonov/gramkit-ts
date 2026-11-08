import type { Db } from './db/client';
import { AdminUsersRepo } from './modules/admin/repo';
import { AnalyticsRepo } from './modules/analytics/repo';
import { AuditLogRepo } from './modules/audit-log/repo';
import { BalanceRepo } from './modules/balance/repo';
import { PromotionalBroadcastsRepo } from './modules/broadcasts/repo';
import { GroupMembersRepo, GroupsRepo } from './modules/groups/repo';
import { InvitesRepo } from './modules/invites/repo';
import { MarketingLinksRepo } from './modules/marketing-links/repo';
import { NotificationDeliveriesRepo } from './modules/notifications/repo';
import { PaymentEventsRepo, PaymentsRepo } from './modules/payments/repo';
import { SubscriptionsRepo } from './modules/subscriptions/repo';
import { UsersRepo } from './modules/users/repo';

/** Repository aggregator (Python's `RequestsRepo`): every repo on one `Db`, built on first use. */
export class Repos {
  #users?: UsersRepo;
  #balance?: BalanceRepo;
  #groups?: GroupsRepo;
  #members?: GroupMembersRepo;
  #invites?: InvitesRepo;
  #payments?: PaymentsRepo;
  #paymentEvents?: PaymentEventsRepo;
  #subscriptions?: SubscriptionsRepo;
  #notificationDeliveries?: NotificationDeliveriesRepo;
  #auditLog?: AuditLogRepo;
  #adminUsers?: AdminUsersRepo;
  #analytics?: AnalyticsRepo;
  #promotionalBroadcasts?: PromotionalBroadcastsRepo;
  #marketingLinks?: MarketingLinksRepo;

  constructor(readonly db: Db) {}

  get users() {
    return (this.#users ??= new UsersRepo(this.db));
  }

  get balance() {
    return (this.#balance ??= new BalanceRepo(this.db));
  }

  get groups() {
    return (this.#groups ??= new GroupsRepo(this.db));
  }

  get members() {
    return (this.#members ??= new GroupMembersRepo(this.db));
  }

  get invites() {
    return (this.#invites ??= new InvitesRepo(this.db));
  }

  get payments() {
    return (this.#payments ??= new PaymentsRepo(this.db));
  }

  get paymentEvents() {
    return (this.#paymentEvents ??= new PaymentEventsRepo(this.db));
  }

  get subscriptions() {
    return (this.#subscriptions ??= new SubscriptionsRepo(this.db));
  }

  get notificationDeliveries() {
    return (this.#notificationDeliveries ??= new NotificationDeliveriesRepo(this.db));
  }

  get auditLog() {
    return (this.#auditLog ??= new AuditLogRepo(this.db));
  }

  get adminUsers() {
    return (this.#adminUsers ??= new AdminUsersRepo(this.db));
  }

  get analytics() {
    return (this.#analytics ??= new AnalyticsRepo(this.db));
  }

  get promotionalBroadcasts() {
    return (this.#promotionalBroadcasts ??= new PromotionalBroadcastsRepo(this.db));
  }

  get marketingLinks() {
    return (this.#marketingLinks ??= new MarketingLinksRepo(this.db));
  }
}
