import type { Db } from '../../../../src/server/db/client';
import { BaseRepo } from '../../../../src/server/db/repo/base';
import { tags } from '../db/schema';

export class TagsRepo extends BaseRepo<typeof tags> {
  constructor(db: Db) {
    super(db, tags, tags.id);
  }

  async allNames(): Promise<string[]> {
    const rows = await this.db.select({ name: tags.name }).from(tags).orderBy(tags.name);
    return rows.map((row) => row.name);
  }
}
