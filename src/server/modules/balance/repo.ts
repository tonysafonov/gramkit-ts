import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { balances } from '../../db/schema';

export class BalanceRepo extends BaseRepo<typeof balances> {
  constructor(db: Db) {
    super(db, balances, balances.userId);
  }
}
