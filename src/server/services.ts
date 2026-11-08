import type { Bot } from 'grammy';
import type { QueueClient } from './clients/queue';
import type { RabbitProducer } from './clients/rabbit';
import type { RedisClient } from './clients/redis';
import { settings } from './config';
import { AdminService } from './modules/admin/service';
import { AdminTasksService } from './modules/admin-tasks/service';
import { AnalyticsService } from './modules/analytics/service';
import { AuditLogService } from './modules/audit-log/service';
import { AuthService } from './modules/auth/service';
import { BalanceService } from './modules/balance/service';
import { BroadcastsService } from './modules/broadcasts/service';
import { GroupsService } from './modules/groups/service';
import { InvitesService } from './modules/invites/service';
import { type MarketingLinksConfig, MarketingLinksService } from './modules/marketing-links/service';
import { MessagesService } from './modules/messages/service';
import { NotificationsService } from './modules/notifications/service';
import { products } from './modules/payments/products';
import { PaymentsService } from './modules/payments/service';
import { SessionsService } from './modules/sessions/service';
import { INTERNAL_REFERRAL_CODES } from './modules/start/referrals';
import { StartService } from './modules/start/service';
import { StatisticsService } from './modules/statistics/service';
import { SubscriptionsService } from './modules/subscriptions/service';
import { TelegramLinkService } from './modules/telegram-link/service';
import { UsersService } from './modules/users/service';
import { WorkerService } from './modules/worker/service';
import type { Repos } from './repos';

/** Service aggregator (Python's `RequestsService`): one per request, every service built on first use. */
export class Services {
  readonly products = products;
  /** The app's own link codes: never stored as an acquisition source. See `StartService`. */
  readonly internalReferalIds = INTERNAL_REFERRAL_CODES;
  /** How the app measures marketing links. `null`: activity = the user opened the app. */
  readonly marketingLinksConfig: MarketingLinksConfig | null = null;

  #users?: UsersService;
  #groups?: GroupsService;
  #invites?: InvitesService;
  #payments?: PaymentsService;
  #subscriptions?: SubscriptionsService;
  #worker?: WorkerService;
  #auth?: AuthService;
  #start?: StartService;
  #messages?: MessagesService;
  #sessions?: SessionsService;
  #auditLog?: AuditLogService;
  #admin?: AdminService;
  #statistics?: StatisticsService;
  #analytics?: AnalyticsService;
  #adminTasks?: AdminTasksService;
  #broadcasts?: BroadcastsService;
  #marketingLinks?: MarketingLinksService;
  #balance?: BalanceService;
  #notifications?: NotificationsService;
  #telegramLink?: TelegramLinkService;

  constructor(
    readonly repos: Repos,
    readonly producer: RabbitProducer,
    readonly bot: Bot | null,
    readonly redis: RedisClient,
    readonly queue: QueueClient,
  ) {}

  get users() {
    return (this.#users ??= new UsersService(this.repos, this.producer, this, this.bot));
  }

  get groups() {
    return (this.#groups ??= new GroupsService(this.repos, this.producer, this, this.bot));
  }

  get invites() {
    return (this.#invites ??= new InvitesService(this.repos, this.producer, this, this.bot));
  }

  get payments() {
    return (this.#payments ??= new PaymentsService(this.repos, this.producer, this, this.bot, this.products));
  }

  get subscriptions() {
    return (this.#subscriptions ??= new SubscriptionsService(this.repos, this.producer, this, this.bot, this.products));
  }

  get worker() {
    return (this.#worker ??= new WorkerService(this.queue, this.repos, this.producer, this, this.bot));
  }

  get auth() {
    return (this.#auth ??= new AuthService(this.repos, this.producer, this, this.bot));
  }

  get start() {
    return (this.#start ??= new StartService(this.repos, this.producer, this, this.bot, this.internalReferalIds));
  }

  get messages() {
    return (this.#messages ??= new MessagesService(this.repos, this.producer, this, this.bot));
  }

  get sessions() {
    return (this.#sessions ??= new SessionsService(this.redis));
  }

  get auditLog() {
    return (this.#auditLog ??= new AuditLogService(this.repos, this.producer, this, this.bot));
  }

  get admin() {
    return (this.#admin ??= new AdminService(this.repos, this.producer, this, this.bot));
  }

  get statistics() {
    return (this.#statistics ??= new StatisticsService(this.repos, this.producer, this, this.bot));
  }

  get analytics() {
    return (this.#analytics ??= new AnalyticsService(this.repos, this.producer, this, this.bot));
  }

  get adminTasks() {
    return (this.#adminTasks ??= new AdminTasksService(this.repos, this.producer, this, this.bot));
  }

  get broadcasts() {
    return (this.#broadcasts ??= new BroadcastsService(this.repos, this.producer, this, this.bot));
  }

  get marketingLinks() {
    return (this.#marketingLinks ??= new MarketingLinksService(this.repos, this.producer, this, this.bot));
  }

  get balance() {
    return (this.#balance ??= new BalanceService(this.repos, this.producer, this, this.bot));
  }

  get notifications() {
    return (this.#notifications ??= new NotificationsService(this.repos, this.producer, this, this.bot));
  }

  get telegramLink() {
    return (this.#telegramLink ??= new TelegramLinkService(this.redis, this.repos.users, settings.bot.url));
  }
}
