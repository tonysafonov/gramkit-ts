import type { Db } from '../../../../src/server/db/client';
import { ArticlesRepo } from './articles';
import { CommentsRepo } from './comments';
import { TagsRepo } from './tags';
import { UsersRepo } from './users';

/** Repository aggregator, composed like the framework's `Repos`: one per request, on its transaction. */
export class ConduitRepos {
  #conduitUsers?: UsersRepo;
  #articles?: ArticlesRepo;
  #comments?: CommentsRepo;
  #tags?: TagsRepo;

  constructor(readonly db: Db) {}

  get conduitUsers() {
    return (this.#conduitUsers ??= new UsersRepo(this.db));
  }

  get articles() {
    return (this.#articles ??= new ArticlesRepo(this.db));
  }

  get comments() {
    return (this.#comments ??= new CommentsRepo(this.db));
  }

  get tags() {
    return (this.#tags ??= new TagsRepo(this.db));
  }
}
