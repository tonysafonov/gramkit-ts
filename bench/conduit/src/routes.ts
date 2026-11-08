/** The 19 Conduit endpoints (SPEC.md "Endpoints"). Thin: parse, call a service, wrap the result. */
import { Hono, type MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { typedContext } from '../../../src/server/auth/context';
import { validate } from '../../../src/server/lib/validate';
import { authOptional, authRequired, type ConduitEnv, parseUint } from './auth';
import { NotFoundError, UnprocessableError } from './errors';
import type { ConduitRepos } from './repos';
import { LoginBody, NewArticleBody, NewCommentBody, NewUserBody, UpdateArticleBody, UpdateUserBody } from './schemas';
import type { ConduitServices } from './services';

/**
 * Order on a route: auth, then validation, then `getServices`. FastAPI resolves the token first; its session starts
 * with the first query, so a bad body never touches the database. `getServices` opens the transaction here, so it goes
 * last.
 */
const getServices = typedContext<ConduitServices, ConduitRepos>()
  .getServices as unknown as MiddlewareHandler<ConduitEnv>;

/**
 * `limit` (default 20, 1-100) and `offset` (default 0, >= 0). A present parameter, even empty, must be valid; with
 * repeats the first value counts.
 */
const pageParams = createMiddleware<ConduitEnv>(async (c, next) => {
  let limit: number | null = 20;
  let offset: number | null = 0;
  const limitParam = c.req.query('limit');
  if (limitParam !== undefined) {
    limit = parseUint(limitParam);
    if (limit === null || limit < 1 || limit > 100) {
      throw new UnprocessableError('limit must be an integer from 1 to 100');
    }
  }
  const offsetParam = c.req.query('offset');
  if (offsetParam !== undefined) {
    offset = parseUint(offsetParam);
    if (offset === null) throw new UnprocessableError('offset must be an integer >= 0');
  }
  c.set('page', { limit, offset });
  await next();
});

export const conduitRoutes = new Hono<ConduitEnv>()
  .basePath('/api')

  // users and auth
  .post('/users', validate('json', NewUserBody), getServices, async (c) => {
    const { username, email, password } = c.req.valid('json').user;
    return c.json({ user: await c.get('services').conduitUsers.register(username, email, password) }, 201);
  })
  .post('/users/login', validate('json', LoginBody), getServices, async (c) => {
    const { email, password } = c.req.valid('json').user;
    return c.json({ user: await c.get('services').conduitUsers.login(email, password) });
  })
  .get('/user', authRequired, getServices, async (c) => {
    const { userId, token } = c.get('viewer');
    return c.json({ user: await c.get('services').conduitUsers.current(userId, token) });
  })
  .put('/user', authRequired, validate('json', UpdateUserBody), getServices, async (c) => {
    const { userId, token } = c.get('viewer');
    return c.json({ user: await c.get('services').conduitUsers.update(userId, token, c.req.valid('json').user) });
  })

  // profiles
  .get('/profiles/:username', authOptional, getServices, async (c) => {
    const profile = await c.get('services').conduitUsers.profile(c.get('viewer').userId, c.req.param('username'));
    return c.json({ profile });
  })
  .post('/profiles/:username/follow', authRequired, getServices, async (c) => {
    const { userId } = c.get('viewer');
    return c.json({ profile: await c.get('services').conduitUsers.setFollow(userId, c.req.param('username'), true) });
  })
  .delete('/profiles/:username/follow', authRequired, getServices, async (c) => {
    const { userId } = c.get('viewer');
    return c.json({ profile: await c.get('services').conduitUsers.setFollow(userId, c.req.param('username'), false) });
  })

  // articles
  .get('/articles', authOptional, pageParams, getServices, async (c) => {
    const { limit, offset } = c.get('page');
    return c.json(
      await c
        .get('services')
        .articles.list(
          c.get('viewer').userId,
          limit,
          offset,
          c.req.query('tag') ?? '',
          c.req.query('author') ?? '',
          c.req.query('favorited') ?? '',
        ),
    );
  })
  .get('/articles/feed', authRequired, pageParams, getServices, async (c) => {
    const { limit, offset } = c.get('page');
    return c.json(await c.get('services').articles.feed(c.get('viewer').userId, limit, offset));
  })
  .get('/articles/:slug', authOptional, getServices, async (c) => {
    return c.json({ article: await c.get('services').articles.get(c.get('viewer').userId, c.req.param('slug')) });
  })
  .post('/articles', authRequired, validate('json', NewArticleBody), getServices, async (c) => {
    const article = await c.get('services').articles.create(c.get('viewer').userId, c.req.valid('json').article);
    return c.json({ article }, 201);
  })
  .put('/articles/:slug', authRequired, validate('json', UpdateArticleBody), getServices, async (c) => {
    const { userId } = c.get('viewer');
    const article = await c.get('services').articles.update(userId, c.req.param('slug'), c.req.valid('json').article);
    return c.json({ article });
  })
  .delete('/articles/:slug', authRequired, getServices, async (c) => {
    await c.get('services').articles.delete(c.get('viewer').userId, c.req.param('slug'));
    return c.body(null, 204);
  })

  // favorites
  .post('/articles/:slug/favorite', authRequired, getServices, async (c) => {
    const { userId } = c.get('viewer');
    return c.json({ article: await c.get('services').articles.setFavorite(userId, c.req.param('slug'), true) });
  })
  .delete('/articles/:slug/favorite', authRequired, getServices, async (c) => {
    const { userId } = c.get('viewer');
    return c.json({ article: await c.get('services').articles.setFavorite(userId, c.req.param('slug'), false) });
  })

  // comments
  .get('/articles/:slug/comments', authOptional, getServices, async (c) => {
    return c.json({ comments: await c.get('services').comments.list(c.get('viewer').userId, c.req.param('slug')) });
  })
  .post('/articles/:slug/comments', authRequired, validate('json', NewCommentBody), getServices, async (c) => {
    const { body } = c.req.valid('json').comment;
    const comment = await c.get('services').comments.add(c.get('viewer').userId, c.req.param('slug'), body);
    return c.json({ comment }, 201);
  })
  .delete('/articles/:slug/comments/:id', authRequired, getServices, async (c) => {
    const commentId = parseUint(c.req.param('id'));
    if (commentId === null) throw new NotFoundError('comment not found');
    await c.get('services').comments.delete(c.get('viewer').userId, c.req.param('slug'), commentId);
    return c.body(null, 204);
  })

  // tags
  .get('/tags', getServices, async (c) => {
    return c.json({ tags: await c.get('services').articles.tags() });
  });
