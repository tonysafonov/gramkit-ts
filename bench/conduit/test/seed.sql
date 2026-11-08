-- A small seed for local runs: bench/conduit/test/local.sh loads it over the challenge's schema.sql.
-- Every user's password is `password123` (cost 10, as the challenge's seed).
INSERT INTO users (id, username, email, password_hash, bio, image) VALUES
  (1, 'alice', 'alice@example.com', :'hash', 'Alice bio', NULL),
  (2, 'bob', 'bob@example.com', :'hash', NULL, 'https://example.com/bob.png'),
  (3, 'carol', 'carol@example.com', :'hash', NULL, NULL);
SELECT setval(pg_get_serial_sequence('users', 'id'), 100);

INSERT INTO tags (id, name) VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma');
SELECT setval(pg_get_serial_sequence('tags', 'id'), 100);

INSERT INTO articles (id, slug, author_id, title, description, body, created_at, updated_at)
SELECT n, 'seed-article-' || n, 1 + n % 2, 'Seed article ' || n, 'Description ' || n, 'Body of article ' || n,
       timestamptz '2025-04-01 12:00:00.123999+00' + n * interval '1 hour',
       timestamptz '2025-04-01 12:00:00.123999+00' + n * interval '1 hour'
  FROM generate_series(1, 30) n;
SELECT setval(pg_get_serial_sequence('articles', 'id'), 1000);

INSERT INTO article_tags (article_id, tag_id)
SELECT n, 1 + n % 3 FROM generate_series(1, 30) n
UNION ALL SELECT n, 1 + (n + 1) % 3 FROM generate_series(1, 30, 2) n;

INSERT INTO follows (follower_id, followee_id) VALUES (3, 1), (3, 2), (1, 2);
INSERT INTO favorites (user_id, article_id) VALUES (1, 30), (2, 30), (3, 30), (3, 29);
INSERT INTO comments (article_id, author_id, body) VALUES (30, 2, 'First'), (30, 3, 'Second'), (29, 1, 'Third');
SELECT setval(pg_get_serial_sequence('comments', 'id'), 1000);
