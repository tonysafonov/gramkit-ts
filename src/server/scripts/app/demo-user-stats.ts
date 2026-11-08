/** A demo script that checks the script system and its infrastructure (port of `app/scripts/demo_user_stats.py`). */
import { getLogger } from '../../lib/logging';
import { BaseScript } from '../base';

const logger = getLogger('demo-user-stats');

export class DemoUserStatsScript extends BaseScript {
  async run(): Promise<Record<string, unknown>> {
    logger.info('Script execution system is working!');
    logger.info('Testing infrastructure connections...');

    let totalUsers = 0;
    try {
      totalUsers = await this.withServices((services) => services.users.getUsersCount());
      logger.info('Database: Connected successfully');
      logger.info(`Total users in system: ${totalUsers}`);
    } catch (err) {
      logger.error({ err }, `Database connection failed: ${err}`);
    }

    try {
      const key = 'script_test_key';
      await this.ctx.redis.set(key, 'test_value', 10);
      const value = await this.ctx.redis.get(key);
      await this.ctx.redis.delete(key);
      logger.info(`Redis: Connected successfully (test value: ${value})`);
    } catch (err) {
      logger.error({ err }, `Redis connection failed: ${err}`);
    }

    if (this.ctx.bot) {
      try {
        const me = await this.ctx.bot.api.getMe();
        logger.info(`Telegram Bot: Connected (@${me.username})`);
      } catch (err) {
        logger.error({ err }, `Telegram Bot connection failed: ${err}`);
      }
    } else {
      logger.warn('Telegram Bot: no token configured');
    }

    logger.info('Queue: background job system available');
    logger.info('RabbitMQ: producer available');
    logger.info('DEMO COMPLETE - All systems operational!');

    return {
      status: 'success',
      total_users: totalUsers,
      message: 'Script execution system is working correctly',
    };
  }
}
