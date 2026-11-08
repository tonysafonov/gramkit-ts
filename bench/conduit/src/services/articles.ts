import { ForbiddenError, NotFoundError } from '../errors';
import type { ArticlePage } from '../repos/articles';
import {
  type ArticleOut,
  type ArticlesResponse,
  type NewArticle,
  toArticle,
  toArticleListItem,
  type UpdateArticle,
} from '../schemas';
import { BaseService } from './base';

const toPage = ({ rows, total }: ArticlePage): ArticlesResponse => ({
  articles: rows.map(toArticleListItem),
  articlesCount: total,
});

export class ArticlesService extends BaseService {
  async list(
    viewer: number,
    limit: number,
    offset: number,
    tag: string,
    author: string,
    favorited: string,
  ): Promise<ArticlesResponse> {
    // Only the first non-empty filter applies, in the order tag, author, favorited.
    const repo = this.repos.articles;
    if (tag) return toPage(await repo.listByTag(viewer, limit, offset, tag));
    if (author) return toPage(await repo.listByAuthor(viewer, limit, offset, author));
    if (favorited) return toPage(await repo.listFavoritedBy(viewer, limit, offset, favorited));
    return toPage(await repo.listAll(viewer, limit, offset));
  }

  async feed(viewer: number, limit: number, offset: number): Promise<ArticlesResponse> {
    return toPage(await this.repos.articles.feed(viewer, limit, offset));
  }

  async get(viewer: number, slug: string): Promise<ArticleOut> {
    const row = await this.repos.articles.getFullBySlug(viewer, slug);
    if (row === null) throw new NotFoundError('article not found');
    return toArticle(row);
  }

  private async full(viewer: number, articleId: number): Promise<ArticleOut> {
    const row = await this.repos.articles.getFullById(viewer, articleId);
    if (row === null) throw new NotFoundError('article not found');
    return toArticle(row);
  }

  async create(viewer: number, data: NewArticle): Promise<ArticleOut> {
    const articleId = await this.repos.articles.createArticle(viewer, data.title, data.description, data.body);
    if (data.tagList?.length) await this.repos.articles.addTags(articleId, data.tagList);
    return this.full(viewer, articleId);
  }

  private async ownedId(viewer: number, slug: string): Promise<number> {
    const row = await this.repos.articles.getOwner(slug);
    if (row === null) throw new NotFoundError('article not found');
    if (row.authorId !== viewer) throw new ForbiddenError('not the author of this article');
    return row.id;
  }

  async update(viewer: number, slug: string, data: UpdateArticle): Promise<ArticleOut> {
    const articleId = await this.ownedId(viewer, slug);
    await this.repos.articles.updateFields(articleId, data.title, data.description, data.body);
    return this.full(viewer, articleId);
  }

  async delete(viewer: number, slug: string): Promise<void> {
    await this.repos.articles.deleteArticle(await this.ownedId(viewer, slug));
  }

  async setFavorite(viewer: number, slug: string, favorite: boolean): Promise<ArticleOut> {
    const articleId = await this.repos.articles.getIdBySlug(slug);
    if (articleId === null) throw new NotFoundError('article not found');
    if (favorite) await this.repos.articles.favorite(viewer, articleId);
    else await this.repos.articles.unfavorite(viewer, articleId);
    return this.full(viewer, articleId);
  }

  tags(): Promise<string[]> {
    return this.repos.tags.allNames();
  }
}
