import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../../../src/server/db/client';
import { BaseRepo } from '../../../../src/server/db/repo/base';
import { articles, comments, users } from '../db/schema';
import { followingExpr } from './users';

const COMMENTS_CAP = 100;

export class CommentsRepo extends BaseRepo<typeof comments> {
  constructor(db: Db) {
    super(db, comments, comments.id);
  }

  listForArticle(viewer: number, articleId: number) {
    return this.db
      .select({
        id: comments.id,
        body: comments.body,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
        username: users.username,
        bio: users.bio,
        image: users.image,
        following: followingExpr(this.db, viewer, comments.authorId),
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.articleId, articleId))
      .orderBy(desc(comments.createdAt), desc(comments.id))
      .limit(COMMENTS_CAP);
  }

  async add(articleId: number, authorId: number, body: string) {
    const c = this.db.$with('c').as(
      this.db.insert(comments).values({ articleId, authorId, body }).returning({
        id: comments.id,
        body: comments.body,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
        authorId: comments.authorId,
      }),
    );
    const rows = await this.db
      .with(c)
      .select({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        username: users.username,
        bio: users.bio,
        image: users.image,
      })
      .from(c)
      .innerJoin(users, eq(users.id, c.authorId));
    return rows[0] as NonNullable<(typeof rows)[0]>;
  }

  async getAuthorId(commentId: number, slug: string): Promise<number | null> {
    const rows = await this.db
      .select({ authorId: comments.authorId })
      .from(comments)
      .innerJoin(articles, eq(articles.id, comments.articleId))
      .where(and(eq(comments.id, commentId), eq(articles.slug, slug)));
    return rows[0]?.authorId ?? null;
  }

  async deleteComment(commentId: number): Promise<void> {
    await this.db.delete(comments).where(eq(comments.id, commentId));
  }
}
