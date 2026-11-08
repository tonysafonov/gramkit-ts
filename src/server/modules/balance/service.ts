import type { Balance } from '../../db/schema';
import { BaseService } from '../../lib/base-service';

/**
 * Per-user balance (credits, limits). Minimal, as in the template: extend it with app-specific methods (deduct a
 * credit with `repos.balance.getByIdWithLock`, feature limits, usage tracking).
 */
export class BalanceService extends BaseService {
  /** The user's balance, created with defaults if there is none. */
  async getOrCreateBalance(userId: string): Promise<Balance> {
    const balance = await this.repos.balance.getById(userId);
    if (balance) return balance;
    return this.repos.balance.create({ userId });
  }

  getBalance(userId: string): Promise<Balance | null> {
    return this.repos.balance.getById(userId);
  }

  updateBalance(userId: string, balanceData: Partial<Omit<Balance, 'userId'>>): Promise<Balance | null> {
    return this.repos.balance.update(userId, balanceData);
  }
}
