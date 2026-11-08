/**
 * Request bodies (zod) and the wire shapes they answer with: Python's `schemas.py`. Field names are the API's
 * camelCase. Responses are built by the mappers below and not validated again at runtime (see README).
 */
import { z } from 'zod';

const NonEmpty = z.string().min(1);
const optional = <T extends z.ZodType>(schema: T) => schema.nullish();

export const NewUserBody = z.object({
  user: z.object({ username: NonEmpty, email: NonEmpty, password: NonEmpty }),
});

export const LoginBody = z.object({
  user: z.object({ email: NonEmpty, password: NonEmpty }),
});

const UpdateUser = z.object({
  email: optional(NonEmpty),
  username: optional(NonEmpty),
  password: optional(NonEmpty),
  bio: optional(z.string()),
  image: optional(z.string()),
});
export type UpdateUser = z.infer<typeof UpdateUser>;
export const UpdateUserBody = z.object({ user: UpdateUser });

const NewArticle = z.object({
  title: NonEmpty,
  description: NonEmpty,
  body: NonEmpty,
  tagList: optional(z.array(NonEmpty)),
});
export type NewArticle = z.infer<typeof NewArticle>;
export const NewArticleBody = z.object({ article: NewArticle });

const UpdateArticle = z.object({
  title: optional(NonEmpty),
  description: optional(NonEmpty),
  body: optional(NonEmpty),
});
export type UpdateArticle = z.infer<typeof UpdateArticle>;
export const UpdateArticleBody = z.object({ article: UpdateArticle });

export const NewCommentBody = z.object({ comment: z.object({ body: NonEmpty }) });

export interface UserOut {
  email: string;
  token: string;
  username: string;
  bio: string | null;
  image: string | null;
}

export interface ProfileOut {
  username: string;
  bio: string | null;
  image: string | null;
  following: boolean;
}

export interface ArticleListItemOut {
  slug: string;
  title: string;
  description: string;
  tagList: string[];
  createdAt: string;
  updatedAt: string;
  favorited: boolean;
  favoritesCount: number;
  author: ProfileOut;
}

export interface ArticleOut extends ArticleListItemOut {
  body: string;
}

export interface ArticlesResponse {
  articles: ArticleListItemOut[];
  articlesCount: number;
}

export interface CommentOut {
  id: number;
  createdAt: string;
  updatedAt: string;
  body: string;
  author: ProfileOut;
}

/** RFC 3339 UTC with exactly 3 fractional digits (the driver's microseconds are truncated parsing them into a `Date`). */
export const iso = (ts: Date): string => ts.toISOString();

type ProfileRow = Pick<ProfileOut, 'username' | 'bio' | 'image'>;

export const toUser = (row: ProfileRow & { email: string }, token: string): UserOut => ({
  email: row.email,
  token,
  username: row.username,
  bio: row.bio,
  image: row.image,
});

export const toProfile = (row: ProfileRow, following: boolean): ProfileOut => ({
  username: row.username,
  bio: row.bio,
  image: row.image,
  following,
});

interface ArticleRow extends ProfileRow {
  slug: string;
  title: string;
  description: string;
  tagList: string[];
  createdAt: Date;
  updatedAt: Date;
  favorited: boolean;
  favoritesCount: number;
  following: boolean;
}

export const toArticleListItem = (row: ArticleRow): ArticleListItemOut => ({
  slug: row.slug,
  title: row.title,
  description: row.description,
  tagList: row.tagList,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  favorited: row.favorited,
  favoritesCount: row.favoritesCount,
  author: toProfile(row, row.following),
});

export const toArticle = (row: ArticleRow & { body: string }): ArticleOut => ({
  ...toArticleListItem(row),
  body: row.body,
});

interface CommentRow extends ProfileRow {
  id: number;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export const toComment = (row: CommentRow, following: boolean): CommentOut => ({
  id: row.id,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  body: row.body,
  author: toProfile(row, following),
});
