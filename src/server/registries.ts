import { registerBroadcastKeyboards } from './bot/keyboards';
import { registerAdminMetrics } from './modules/statistics/app-metrics';

/**
 * What this app adds to the shared registries: the `daily` broadcast keyboard, the Overview cards and digest rows. The
 * registries are per process, so every entry point calls this: the API, the bot and the worker (Python's
 * `setup_infrastructure()`).
 */
export function setupRegistries(): void {
  registerBroadcastKeyboards();
  registerAdminMetrics();
}
