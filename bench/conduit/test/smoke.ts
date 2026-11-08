/**
 * Every endpoint once against a running server on the small seed: statuses, shapes, the Conduit error body. The
 * challenge's conformance suite (197 steps, on the box) is the real check; this is the one that runs on a laptop.
 */
import { createHmac } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const SECRET = process.env.JWT_SECRET ?? 'dev-secret';

let passed = 0;
let requests = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failures.push(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

// biome-ignore lint/suspicious/noExplicitAny: a smoke test reads whatever JSON came back
type Json = any;

async function call(method: string, path: string, token?: string, body?: unknown, raw?: string) {
  requests++;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: token.startsWith('raw:') ? token.slice(4) : `Token ${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json: Json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, text, type: res.headers.get('content-type'), headers: res.headers };
}

async function expectStatus(name: string, want: number, method: string, path: string, token?: string, body?: unknown) {
  const res = await call(method, path, token, body);
  check(name, res.status === want, { status: res.status, body: res.text.slice(0, 200) });
  return res;
}

async function expectError(name: string, want: number, method: string, path: string, token?: string, body?: unknown) {
  const res = await expectStatus(name, want, method, path, token, body);
  check(
    `${name}.shape`,
    Array.isArray(res.json?.errors?.body) && typeof res.json.errors.body[0] === 'string',
    res.json,
  );
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');
function mint(claims: object, secret = SECRET, alg = 'HS256'): string {
  const head = `${b64(JSON.stringify({ alg, typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`;
  return `${head}.${alg === 'none' ? '' : b64(createHmac('sha256', secret).update(head).digest())}`;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const stamp = Date.now();
const now = Math.floor(stamp / 1000);

// tags
const tags = await expectStatus('tags', 200, 'GET', '/api/tags');
check('tags.sorted', JSON.stringify(tags.json.tags?.slice(0, 3)) === '["alpha","beta","gamma"]', tags.json);
check('tags.type', tags.type?.startsWith('application/json') === true, tags.type);
check('tags.request-id', tags.headers.get('x-request-id') !== null);
check('tags.security', tags.headers.get('x-content-type-options') === 'nosniff');
await expectStatus('tags.ignores-auth', 200, 'GET', '/api/tags', 'not-a-jwt');

// register, login
const name = `smoke_${stamp}`;
const user = { username: name, email: `${name}@example.com`, password: 'smoke-pass' };
const reg = await expectStatus('register', 201, 'POST', '/api/users', undefined, { user });
const token: string = reg.json.user.token;
check('register.user', reg.json.user.username === name && reg.json.user.bio === null, reg.json);
const claims = JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString());
check(
  'token.claims',
  Object.keys(claims).sort().join() === 'exp,iat,sub' && claims.exp - claims.iat === 2592000,
  claims,
);
await expectError('register.taken', 422, 'POST', '/api/users', undefined, { user });
await expectError('register.empty', 422, 'POST', '/api/users', undefined, { user: { ...user, email: '' } });
await expectError('register.no-wrapper', 422, 'POST', '/api/users', undefined, user);
const bad = await call('POST', '/api/users', undefined, undefined, '{"user": {');
check('register.malformed', bad.status === 422 && Array.isArray(bad.json?.errors?.body), bad.text);
await expectError('register.long-password', 422, 'POST', '/api/users', undefined, {
  user: { username: `${name}x`, email: `${name}x@e.com`, password: 'x'.repeat(73) },
});

const login = await expectStatus('login', 200, 'POST', '/api/users/login', undefined, {
  user: { email: 'alice@example.com', password: 'password123' },
});
const alice: string = login.json.user.token;
await expectError('login.bad', 401, 'POST', '/api/users/login', undefined, {
  user: { email: 'alice@example.com', password: 'nope' },
});

// current user, auth failures
const me = await expectStatus('user.get', 200, 'GET', '/api/user', token);
check('user.get.token', me.json.user.token === token);
const sub = claims.sub as string;
for (const [label, bad] of Object.entries({
  bearer: `raw:Bearer ${token}`,
  'no-scheme': `raw:${token}`,
  garbage: 'not.a.jwt',
  wrong: mint({ sub, iat: now, exp: now + 60 }, `${SECRET}-wrong`),
  expired: mint({ sub, iat: now - 100, exp: now - 10 }),
  'no-exp': mint({ sub, iat: now }),
  'numeric-sub': mint({ sub: Number(sub), iat: now, exp: now + 60 }),
  'text-sub': mint({ sub: 'abc', iat: now, exp: now + 60 }),
  'alg-none': mint({ sub, iat: now, exp: now + 60 }, '', 'none'),
  'unknown-user': mint({ sub: '999999', iat: now, exp: now + 60 }),
})) {
  await expectError(`user.401.${label}`, 401, 'GET', '/api/user', bad);
}
await expectError('user.401.none', 401, 'GET', '/api/user');

const updated = await expectStatus('user.update', 200, 'PUT', '/api/user', token, {
  user: { bio: 'New bio', image: 'https://e.com/i.png', email: null },
});
check(
  'user.update.fields',
  updated.json.user.bio === 'New bio' && updated.json.user.email === user.email,
  updated.json,
);
await expectStatus('user.update.empty', 200, 'PUT', '/api/user', token, { user: {} });
await expectError('user.update.taken', 422, 'PUT', '/api/user', token, { user: { username: 'alice' } });
await expectError('user.update.number', 422, 'PUT', '/api/user', token, { user: { bio: 5 } });
await expectStatus('user.update.password', 200, 'PUT', '/api/user', token, { user: { password: 'other-pass' } });
await expectStatus('login.new-password', 200, 'POST', '/api/users/login', undefined, {
  user: { email: user.email, password: 'other-pass' },
});

// profiles
const profile = await expectStatus('profile', 200, 'GET', '/api/profiles/alice');
check(
  'profile.anon',
  profile.json.profile.following === false && profile.json.profile.bio === 'Alice bio',
  profile.json,
);
await expectError('profile.404', 404, 'GET', '/api/profiles/nobody');
await expectError('profile.bad-token', 401, 'GET', '/api/profiles/alice', 'not-a-jwt');
const followed = await expectStatus('follow', 200, 'POST', '/api/profiles/alice/follow', token);
check('follow.true', followed.json.profile.following === true);
await expectStatus('follow.twice', 200, 'POST', '/api/profiles/alice/follow', token);
const seen = await expectStatus('profile.following', 200, 'GET', '/api/profiles/alice', token);
check('profile.following.true', seen.json.profile.following === true);
await expectError('follow.401', 401, 'POST', '/api/profiles/alice/follow');
await expectError('follow.404', 404, 'POST', '/api/profiles/nobody/follow', token);

// lists
const list = await expectStatus('list', 200, 'GET', '/api/articles?limit=5');
const first: Json = list.json.articles[0];
check('list.count', list.json.articles.length === 5 && list.json.articlesCount >= 30, list.json.articlesCount);
check('list.no-body', first.body === undefined && first.slug === 'seed-article-30', first);
check('list.article', first.favoritesCount === 3 && first.favorited === false && Array.isArray(first.tagList), first);
check('list.iso', ISO.test(first.createdAt) && first.createdAt.endsWith('.123Z'), first.createdAt);
const page2 = await expectStatus('list.offset', 200, 'GET', '/api/articles?limit=2&offset=1');
check('list.offset.slug', page2.json.articles[0].slug === 'seed-article-29', page2.json.articles[0]);
await expectStatus('list.leading-zero', 200, 'GET', '/api/articles?limit=05&offset=005');
await expectStatus('list.big-offset', 200, 'GET', '/api/articles?offset=9223372036854775807');
for (const q of [
  'limit=0',
  'limit=101',
  'limit=-1',
  'limit=abc',
  'limit=',
  'limit=1.5',
  'limit=%2B5',
  'limit=%205',
  'offset=-1',
  'offset=',
  'offset=99999999999999999999',
]) {
  await expectError(`list.422.${q}`, 422, 'GET', `/api/articles?${q}`);
}
const byTag = await expectStatus('list.tag', 200, 'GET', '/api/articles?tag=beta&limit=3');
check(
  'list.tag.has',
  byTag.json.articles.every((a: Json) => a.tagList.includes('beta')) && byTag.json.articlesCount > 3,
  byTag.json,
);
const none = await expectStatus('list.tag.unknown', 200, 'GET', '/api/articles?tag=nope');
check('list.tag.empty', none.json.articles.length === 0 && none.json.articlesCount === 0, none.json);
const byAuthor = await expectStatus('list.author', 200, 'GET', '/api/articles?author=bob&limit=3');
check(
  'list.author.is',
  byAuthor.json.articles.every((a: Json) => a.author.username === 'bob'),
  byAuthor.json,
);
const beats = await expectStatus('list.tag-beats-author', 200, 'GET', '/api/articles?author=nobody&tag=beta');
check('list.tag-beats-author.rows', beats.json.articles.length > 0);
const faved = await expectStatus('list.favorited', 200, 'GET', '/api/articles?favorited=carol');
check('list.favorited.rows', faved.json.articles.length === 2 && faved.json.articlesCount === 2, faved.json);

// feed
const carol = mint({ sub: '3', iat: now, exp: now + 60 });
const feed = await expectStatus('feed', 200, 'GET', '/api/articles/feed?limit=4', carol);
check('feed.rows', feed.json.articles.length === 4 && feed.json.articlesCount === 30, feed.json.articlesCount);
check('feed.following', feed.json.articles[0].author.following === true, feed.json.articles[0]);
const feed2 = await expectStatus('feed.offset', 200, 'GET', '/api/articles/feed?limit=2&offset=2', carol);
check('feed.offset.slug', feed2.json.articles[0].slug === feed.json.articles[2].slug, feed2.json.articles[0]);
await expectError('feed.401', 401, 'GET', '/api/articles/feed');
await expectError('feed.422', 422, 'GET', '/api/articles/feed?limit=0', carol);

// one article, create, update, delete
const one = await expectStatus('article', 200, 'GET', '/api/articles/seed-article-30', carol);
check('article.full', one.json.article.body === 'Body of article 30' && one.json.article.favorited === true, one.json);
await expectError('article.404', 404, 'GET', '/api/articles/nope');
const title = `Smoke Title ${stamp}!`;
const created = await expectStatus('article.create', 201, 'POST', '/api/articles', token, {
  article: { title, description: 'd', body: 'b', tagList: ['zeta', 'alpha', 'zeta'] },
});
const slug: string = created.json.article.slug;
check('article.slug', new RegExp(`^smoke-title-${stamp}-\\d+$`).test(slug), slug);
check('article.tags', created.json.article.tagList.join() === 'alpha,zeta', created.json.article.tagList);
await expectStatus('article.create.no-tags', 201, 'POST', '/api/articles', token, {
  article: { title: 'No tags', description: 'd', body: 'b' },
});
await expectError('article.create.401', 401, 'POST', '/api/articles', undefined, { article: {} });
await expectError('article.create.422', 422, 'POST', '/api/articles', token, {
  article: { title: 't', description: '', body: 'b' },
});
await expectError('article.create.tag-422', 422, 'POST', '/api/articles', token, {
  article: { title: 't', description: 'd', body: 'b', tagList: ['ok', ''] },
});
const edited = await expectStatus('article.update', 200, 'PUT', `/api/articles/${slug}`, token, {
  article: { body: 'Updated', title: null },
});
check(
  'article.update.keeps-slug',
  edited.json.article.slug === slug && edited.json.article.body === 'Updated',
  edited.json,
);
const renamed = await expectStatus('article.rename', 200, 'PUT', `/api/articles/${slug}`, token, {
  article: { title: 'Brand New' },
});
const newSlug: string = renamed.json.article.slug;
check('article.rename.slug', /^brand-new-\d+$/.test(newSlug), newSlug);
await expectError('article.update.403', 403, 'PUT', `/api/articles/${newSlug}`, alice, { article: { body: 'x' } });
await expectError('article.update.404', 404, 'PUT', '/api/articles/nope', token, { article: { body: 'x' } });

// favorites
const fav = await expectStatus('favorite', 200, 'POST', `/api/articles/${newSlug}/favorite`, alice);
check('favorite.true', fav.json.article.favorited === true && fav.json.article.favoritesCount === 1, fav.json.article);
await expectStatus('favorite.twice', 200, 'POST', `/api/articles/${newSlug}/favorite`, alice);
const unfav = await expectStatus('unfavorite', 200, 'DELETE', `/api/articles/${newSlug}/favorite`, alice);
check('unfavorite.false', unfav.json.article.favorited === false && unfav.json.article.favoritesCount === 0);
await expectError('favorite.404', 404, 'POST', '/api/articles/nope/favorite', token);

// comments
const comments = await expectStatus('comments', 200, 'GET', '/api/articles/seed-article-30/comments', carol);
check(
  'comments.rows',
  comments.json.comments.length === 2 && typeof comments.json.comments[0].id === 'number',
  comments.json,
);
check(
  'comments.following',
  comments.json.comments.find((c: Json) => c.author.username === 'bob').author.following === true,
);
await expectError('comments.404', 404, 'GET', '/api/articles/nope/comments');
const comment = await expectStatus('comment.add', 201, 'POST', `/api/articles/${newSlug}/comments`, token, {
  comment: { body: 'Hello <b>&</b> ünï' },
});
check(
  'comment.add.body',
  comment.json.comment.body === 'Hello <b>&</b> ünï' && comment.json.comment.author.following === false,
  comment.json,
);
check('comment.add.iso', ISO.test(comment.json.comment.createdAt), comment.json.comment);
const commentId: number = comment.json.comment.id;
await expectError('comment.add.422', 422, 'POST', `/api/articles/${newSlug}/comments`, token, {
  comment: { body: '' },
});
await expectError('comment.add.422-beats-404', 422, 'POST', '/api/articles/nope/comments', token, {
  comment: { body: '' },
});
await expectError('comment.add.404', 404, 'POST', '/api/articles/nope/comments', token, { comment: { body: 'x' } });
await expectError('comment.delete.403', 403, 'DELETE', `/api/articles/${newSlug}/comments/${commentId}`, alice);
await expectError('comment.delete.non-int', 404, 'DELETE', `/api/articles/${newSlug}/comments/abc`, token);
await expectError('comment.delete.huge', 404, 'DELETE', `/api/articles/${newSlug}/comments/9223372036854775807`, token);
const deletedComment = await expectStatus(
  'comment.delete',
  204,
  'DELETE',
  `/api/articles/${newSlug}/comments/${commentId}`,
  token,
);
check('comment.delete.empty', deletedComment.text === '', deletedComment.text);
await expectError('comment.delete.again', 404, 'DELETE', `/api/articles/${newSlug}/comments/${commentId}`, token);

await expectError('article.delete.403', 403, 'DELETE', `/api/articles/${newSlug}`, alice);
await expectStatus('article.delete', 204, 'DELETE', `/api/articles/${newSlug}`, token);
await expectError('article.delete.gone', 404, 'GET', `/api/articles/${newSlug}`);

await expectStatus('unfollow', 200, 'DELETE', '/api/profiles/alice/follow', token);
const after = await expectStatus('unfollow.seen', 200, 'GET', '/api/profiles/alice', token);
check('unfollow.false', after.json.profile.following === false);

// the router's own answers, and a failed write leaving nothing behind
await expectError('router.404', 404, 'GET', '/api/nope');
await expectError('router.405', 405, 'DELETE', '/api/tags');

console.log(`${requests} requests, ${passed + failures.length} checks, ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
