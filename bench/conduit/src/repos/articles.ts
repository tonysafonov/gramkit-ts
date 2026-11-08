/** Articles, tags on articles and favorites: SPEC.md's reference SQL, built with Drizzle. */
import { and, count, desc, eq, exists, inArray, type SQL, type Subquery, sql } from 'drizzle-orm';
import { type AnyPgColumn, alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../../../src/server/db/client';
import { BaseRepo } from '../../../../src/server/db/repo/base';
import { articles, articleTags, favorites, follows, tags, users } from '../db/schema';
import { coalesceText, followingExpr } from './users';

const COUNT_CAP = 1000;

/** SPEC.md SLUGIFY: trim(both '-' from lower(regexp_replace(x, '[^A-Za-z0-9]+', '-', 'g'))). */
const slugify = (title: string): SQL<string> =>
  sql`btrim(lower(regexp_replace(${title}::text, '[^A-Za-z0-9]+', '-', 'g')), '-')`;

/** ARTICLE_LIST_SELECT's columns. */
function listColumns(db: Db, viewer: number) {
  const tagNames = db
    .select({ name: tags.name })
    .from(tags)
    .innerJoin(articleTags, eq(articleTags.tagId, tags.id))
    .where(eq(articleTags.articleId, articles.id))
    .orderBy(tags.name);
  const viewerFavorite = db
    .select({ one: sql`1` })
    .from(favorites)
    .where(and(eq(favorites.articleId, articles.id), eq(favorites.userId, viewer)));
  return {
    id: articles.id,
    slug: articles.slug,
    title: articles.title,
    description: articles.description,
    createdAt: articles.createdAt,
    updatedAt: articles.updatedAt,
    tagList: sql<string[]>`array(${tagNames})`,
    favoritesCount: db.$count(favorites, eq(favorites.articleId, articles.id)),
    favorited: exists(viewerFavorite) as SQL<boolean>,
    username: users.username,
    bio: users.bio,
    image: users.image,
    following: followingExpr(db, viewer, articles.authorId),
  };
}

const articleSelect = (db: Db, viewer: number) =>
  db.select(listColumns(db, viewer)).from(articles).innerJoin(users, eq(users.id, articles.authorId));

/** ARTICLE_FULL_SELECT. */
const fullSelect = (db: Db, viewer: number) =>
  db
    .select({ ...listColumns(db, viewer), body: articles.body })
    .from(articles)
    .innerJoin(users, eq(users.id, articles.authorId));

export type ArticleListRow = Awaited<ReturnType<typeof articleSelect>>[number];

export interface ArticlePage {
  rows: ArticleListRow[];
  total: number;
}

export class ArticlesRepo extends BaseRepo<typeof articles> {
  constructor(db: Db) {
    super(db, articles, articles.id);
  }

  private tagId(tag: string) {
    return this.db.select({ id: tags.id }).from(tags).where(eq(tags.name, tag));
  }

  private userId(username: string) {
    const u = alias(users, 'u2');
    return this.db.select({ id: u.id }).from(u).where(eq(u.username, username));
  }

  /** `SELECT 1`: what a capped count counts. */
  private one() {
    return this.db.select({ one: sql`1`.as('one') });
  }

  /** The page, then the capped count. */
  private async page(page: PromiseLike<ArticleListRow[]>, capped: Subquery): Promise<ArticlePage> {
    const rows = await page;
    const counted = await this.db.select({ total: count() }).from(capped);
    return { rows, total: counted[0]?.total ?? 0 };
  }

  listAll(viewer: number, limit: number, offset: number): Promise<ArticlePage> {
    const page = articleSelect(this.db, viewer).orderBy(desc(articles.id)).limit(limit).offset(offset);
    return this.page(page, this.one().from(articles).limit(COUNT_CAP).as('s'));
  }

  listByTag(viewer: number, limit: number, offset: number, tag: string): Promise<ArticlePage> {
    const ids = this.db
      .select({ id: articleTags.articleId })
      .from(articleTags)
      .where(eq(articleTags.tagId, this.tagId(tag)))
      .orderBy(desc(articleTags.articleId))
      .limit(limit)
      .offset(offset);
    const page = articleSelect(this.db, viewer).where(inArray(articles.id, ids)).orderBy(desc(articles.id));
    const capped = this.one()
      .from(articleTags)
      .where(eq(articleTags.tagId, this.tagId(tag)))
      .limit(COUNT_CAP)
      .as('s');
    return this.page(page, capped);
  }

  listByAuthor(viewer: number, limit: number, offset: number, author: string): Promise<ArticlePage> {
    const page = articleSelect(this.db, viewer)
      .where(eq(articles.authorId, this.userId(author)))
      .orderBy(desc(articles.id))
      .limit(limit)
      .offset(offset);
    const capped = this.one()
      .from(articles)
      .where(eq(articles.authorId, this.userId(author)))
      .limit(COUNT_CAP)
      .as('s');
    return this.page(page, capped);
  }

  listFavoritedBy(viewer: number, limit: number, offset: number, username: string): Promise<ArticlePage> {
    const ids = this.db
      .select({ id: favorites.articleId })
      .from(favorites)
      .where(eq(favorites.userId, this.userId(username)))
      .orderBy(desc(favorites.articleId))
      .limit(limit)
      .offset(offset);
    const page = articleSelect(this.db, viewer).where(inArray(articles.id, ids)).orderBy(desc(articles.id));
    const capped = this.one()
      .from(favorites)
      .where(eq(favorites.userId, this.userId(username)))
      .limit(COUNT_CAP)
      .as('s');
    return this.page(page, capped);
  }

  feed(viewer: number, limit: number, offset: number): Promise<ArticlePage> {
    const a2 = alias(articles, 'a2');
    const latest = this.db
      .select({ id: a2.id })
      .from(a2)
      .where(eq(a2.authorId, follows.followeeId))
      .orderBy(desc(a2.id))
      .limit(limit + offset)
      .as('x');
    const ids = this.db
      .select({ id: latest.id })
      .from(follows)
      .crossJoinLateral(latest)
      .where(eq(follows.followerId, viewer))
      .orderBy(desc(latest.id))
      .limit(limit)
      .offset(offset);
    const page = articleSelect(this.db, viewer).where(inArray(articles.id, ids)).orderBy(desc(articles.id));
    const followees = this.db.select({ id: follows.followeeId }).from(follows).where(eq(follows.followerId, viewer));
    const capped = this.one().from(articles).where(inArray(articles.authorId, followees)).limit(COUNT_CAP).as('s');
    return this.page(page, capped);
  }

  async getFullBySlug(viewer: number, slug: string) {
    const rows = await fullSelect(this.db, viewer).where(eq(articles.slug, slug));
    return rows[0] ?? null;
  }

  async getFullById(viewer: number, articleId: number) {
    const rows = await fullSelect(this.db, viewer).where(eq(articles.id, articleId));
    return rows[0] ?? null;
  }

  async getIdBySlug(slug: string): Promise<number | null> {
    const rows = await this.db.select({ id: articles.id }).from(articles).where(eq(articles.slug, slug));
    return rows[0]?.id ?? null;
  }

  async getOwner(slug: string) {
    const rows = await this.db
      .select({ id: articles.id, authorId: articles.authorId })
      .from(articles)
      .where(eq(articles.slug, slug));
    return rows[0] ?? null;
  }

  async createArticle(authorId: number, title: string, description: string, body: string): Promise<number> {
    // The id comes first, so the slug can carry it: one statement, as in SPEC.md
    const source = this.db
      .select({
        id: sql<number>`n.id`.as('id'),
        slug: sql<string>`${slugify(title)} || '-' || n.id`.as('slug'),
        authorId: sql<number>`${authorId}::bigint`.as('author_id'),
        title: sql<string>`${title}::text`.as('title'),
        description: sql<string>`${description}::text`.as('description'),
        body: sql<string>`${body}::text`.as('body'),
        createdAt: sql<Date>`now()`.as('created_at'),
        updatedAt: sql<Date>`now()`.as('updated_at'),
      })
      .from(sql`(select nextval(pg_get_serial_sequence('articles', 'id')) as id) n`);
    const rows = await this.db.insert(articles).select(source).returning({ id: articles.id });
    return (rows[0] as { id: number }).id;
  }

  async addTags(articleId: number, names: string[]): Promise<void> {
    const unique = [...new Set(names)];
    await this.db
      .insert(tags)
      .values(unique.map((name) => ({ name })))
      .onConflictDoNothing({ target: tags.name });
    await this.db.insert(articleTags).select(
      this.db
        .select({ articleId: sql<number>`${articleId}::bigint`.as('article_id'), tagId: tags.id })
        .from(tags)
        .where(inArray(tags.name, unique)),
    );
  }

  async updateFields(
    articleId: number,
    title: string | null | undefined,
    description: string | null | undefined,
    body: string | null | undefined,
  ): Promise<void> {
    await this.db
      .update(articles)
      .set({
        title: coalesceText(title, articles.title),
        description: coalesceText(description, articles.description),
        body: coalesceText(body, articles.body),
        slug: title == null ? (articles.slug as AnyPgColumn) : sql`${slugify(title)} || '-' || ${articles.id}`,
        updatedAt: sql`now()`,
      })
      .where(eq(articles.id, articleId));
  }

  async deleteArticle(articleId: number): Promise<void> {
    await this.db.delete(articles).where(eq(articles.id, articleId));
  }

  async favorite(userId: number, articleId: number): Promise<void> {
    await this.db.insert(favorites).values({ userId, articleId }).onConflictDoNothing();
  }

  async unfavorite(userId: number, articleId: number): Promise<void> {
    await this.db.delete(favorites).where(and(eq(favorites.userId, userId), eq(favorites.articleId, articleId)));
  }
}
