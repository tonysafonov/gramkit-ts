import { ForbiddenError, NotFoundError } from '../errors';
import { type CommentOut, toComment } from '../schemas';
import { BaseService } from './base';

export class CommentsService extends BaseService {
  private async articleId(slug: string): Promise<number> {
    const articleId = await this.repos.articles.getIdBySlug(slug);
    if (articleId === null) throw new NotFoundError('article not found');
    return articleId;
  }

  async list(viewer: number, slug: string): Promise<CommentOut[]> {
    const articleId = await this.articleId(slug);
    const rows = await this.repos.comments.listForArticle(viewer, articleId);
    return rows.map((row) => toComment(row, row.following));
  }

  async add(viewer: number, slug: string, body: string): Promise<CommentOut> {
    const articleId = await this.articleId(slug);
    return toComment(await this.repos.comments.add(articleId, viewer, body), false);
  }

  async delete(viewer: number, slug: string, commentId: number): Promise<void> {
    const authorId = await this.repos.comments.getAuthorId(commentId, slug);
    if (authorId === null) throw new NotFoundError('comment not found');
    if (authorId !== viewer) throw new ForbiddenError('not the author of this comment');
    await this.repos.comments.deleteComment(commentId);
  }
}
