/**
 * Tables over the challenge's fixed schema (`schema.sql`). The schema is created by the challenge's seed, never by us:
 * no migrations, and the framework's own tables (its `users` among them) don't apply here.
 */
import { bigint, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity();
const reference = (name: string) => bigint(name, { mode: 'number' }).notNull();
const timestampColumn = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: id(),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  bio: text('bio'),
  image: text('image'),
  createdAt: timestampColumn('created_at'),
});

export const follows = pgTable(
  'follows',
  {
    followerId: reference('follower_id').references(() => users.id),
    followeeId: reference('followee_id').references(() => users.id),
    createdAt: timestampColumn('created_at'),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followeeId] })],
);

export const articles = pgTable('articles', {
  id: id(),
  slug: text('slug').notNull().unique(),
  authorId: reference('author_id').references(() => users.id),
  title: text('title').notNull(),
  description: text('description').notNull(),
  body: text('body').notNull(),
  createdAt: timestampColumn('created_at'),
  updatedAt: timestampColumn('updated_at'),
});

export const tags = pgTable('tags', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull().unique(),
});

export const articleTags = pgTable(
  'article_tags',
  {
    articleId: reference('article_id').references(() => articles.id),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id),
  },
  (t) => [primaryKey({ columns: [t.articleId, t.tagId] })],
);

export const favorites = pgTable(
  'favorites',
  {
    userId: reference('user_id').references(() => users.id),
    articleId: reference('article_id').references(() => articles.id),
    createdAt: timestampColumn('created_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.articleId] })],
);

export const comments = pgTable('comments', {
  id: id(),
  articleId: reference('article_id').references(() => articles.id),
  authorId: reference('author_id').references(() => users.id),
  body: text('body').notNull(),
  createdAt: timestampColumn('created_at'),
  updatedAt: timestampColumn('updated_at'),
});
