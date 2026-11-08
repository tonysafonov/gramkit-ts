/**
 * The real processes against the local Postgres and Redis (`make up`), on both runtimes: the API, the worker and the
 * bot, each as its production entry point. Only Telegram is fake: a local Bot API server, reached through
 * `smoke/telegram-redirect.mjs`, so production code has no test switch.
 *
 *     bun run smoke          # builds, then runs Bun and Node
 *
 * Uses its own database (`gramkit_smoke`) and queue (`APP_NAME=smoke`). Exits 1 on the first check that fails.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

const DATABASE = 'gramkit_smoke';
const OWNER = 111_001;
const NEW_USER = 111_002;
const API_PORT = 18_031;

Object.assign(process.env, {
  ENV_FILE: '.env.example',
  APP_NAME: 'smoke',
  DEBUG: 'true',
  LOG_LEVEL: 'info',
  DB__NAME: DATABASE,
  BOT__TOKEN: '123456:smoke-token',
  RBAC__OWNER_IDS: `[${OWNER}]`,
  PORT: String(API_PORT),
  WORKERS: '1',
});

const { settings } = await import('../src/server/config');
const { runMigrations } = await import('../src/server/db/migrate');
const { QueueClient, QUEUE_NAME, queueConnection } = await import('../src/server/clients/queue');
const { Queue } = await import('bullmq');
const postgres = (await import('postgres')).default;

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** The Bot API, as much of it as the processes call at start and in these checks. */
function fakeTelegram() {
  const calls: Call[] = [];
  const updates: unknown[] = [];
  let updateId = 1;
  let messageId = 1;

  const server = createServer(async (req, res) => {
    const method = req.url?.split('/').at(-1) ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (method !== 'getUpdates') calls.push({ method, body });

    const send = (result: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method === 'getMe') {
      send({ id: 123456, is_bot: true, first_name: 'Smoke', username: 'smoke_bot' });
    } else if (method === 'getUpdates') {
      if (updates.length === 0) await new Promise((done) => setTimeout(done, 100));
      send(updates.splice(0));
    } else if (method.startsWith('send')) {
      messageId += 1;
      const date = Math.floor(Date.now() / 1000);
      send({ message_id: messageId, date, chat: { id: body.chat_id, type: 'private' }, text: body.text });
    } else {
      send(true);
    }
  });

  return {
    calls,
    server,
    /** A private message, as `getUpdates` hands it to the bot. */
    deliver(text: string, fromId: number) {
      const from = { id: fromId, is_bot: false, first_name: 'Smoke', username: `smoke_${fromId}`, language_code: 'ru' };
      const command = /^\/\w+/.exec(text);
      updates.push({
        update_id: updateId++,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: fromId, type: 'private', first_name: 'Smoke' },
          from,
          text,
          entities: command ? [{ type: 'bot_command', offset: 0, length: command[0].length }] : undefined,
        },
      });
    },
  };
}

class Process {
  output = '';
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;

  constructor(
    readonly name: string,
    command: string[],
    env: Record<string, string>,
  ) {
    const [file = '', ...args] = command;
    this.child = spawn(file, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout?.on('data', (data) => (this.output += data));
    this.child.stderr?.on('data', (data) => (this.output += data));
    this.exited = new Promise((done) => this.child.once('exit', (code) => done(code)));
  }

  /** SIGTERM, and how it ended. */
  async stop(): Promise<number | null> {
    this.child.kill('SIGTERM');
    return this.exited;
  }
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const ok = (message: string) => console.log(`  ok  ${message}`);

async function checked(process_: Process, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    console.error(`\n--- ${process_.name} output ---\n${process_.output}\n---`);
    process_.child.kill('SIGKILL');
    throw err;
  }
  const code = await process_.stop();
  if (code !== 0) {
    console.error(`\n--- ${process_.name} output ---\n${process_.output}\n---`);
    throw new Error(`${process_.name}: exit code ${code} after SIGTERM`);
  }
  ok(`${process_.name}: clean exit on SIGTERM`);
}

async function api(command: string[], env: Record<string, string>) {
  const server = new Process('api', command, env);
  await checked(server, async () => {
    const url = (path: string) => `http://127.0.0.1:${API_PORT}${path}`;
    await until('/health', async () => (await fetch(url('/health')).catch(() => null))?.ok === true);
    ok('api: /health answers');

    const ready = await fetch(url('/ready'));
    if (ready.status !== 200) throw new Error(`/ready: ${ready.status} ${await ready.text()}`);
    ok('api: /ready answers 200');

    const me = await fetch(url('/users/me'));
    if (me.status !== 200) throw new Error(`/users/me: ${me.status} ${await me.text()}`);
    ok(`api: GET /users/me read the database, user_type ${((await me.json()) as { user_type?: string }).user_type}`);

    const socket = await fetch(url('/socket.io/?EIO=4&transport=polling'));
    if (socket.status !== 200) throw new Error(`socket.io: ${socket.status}`);
    ok('api: Socket.IO handshake');
  });
}

async function worker(command: string[], env: Record<string, string>, telegram: ReturnType<typeof fakeTelegram>) {
  const queue = new QueueClient();
  const inspect = new Queue(QUEUE_NAME, { connection: queueConnection() });
  await inspect.obliterate({ force: true });
  const process_ = new Process('worker', command, env);
  await checked(process_, async () => {
    await until('the worker to start', () => process_.output.includes('Worker started'));
    ok('worker: started');

    const schedulers = await inspect.getJobSchedulers();
    if (schedulers.length !== 7) throw new Error(`expected 7 cron schedulers, got ${schedulers.length}`);
    ok(`worker: ${schedulers.length} cron schedulers in Redis`);

    await queue.enqueueJob('admin_broadcast_job', { text: 'smoke broadcast', silent: true });
    const delivered = () => telegram.calls.some((call) => call.method === 'sendMessage' && call.body.chat_id === OWNER);
    await until('admin_broadcast_job to reach the owner', delivered);
    ok('worker: admin_broadcast_job ran and reached the owner');

    await queue.enqueueJob('daily_admin_statistics_job');
    const digest = () => telegram.calls.some((call) => call.method === 'sendRichMessage');
    await until('daily_admin_statistics_job', digest);
    ok('worker: daily_admin_statistics_job read the database and sent the digest');
  });
  await queue.close();
  await inspect.close();
}

async function bot(command: string[], env: Record<string, string>, telegram: ReturnType<typeof fakeTelegram>) {
  const sql = postgres({ ...settings.db, database: settings.db.name, username: settings.db.user, max: 1 });
  await sql`delete from users where telegram_id = ${NEW_USER}`;
  const process_ = new Process('bot', command, env);
  await checked(process_, async () => {
    await until('polling to start', () => process_.output.includes('Starting polling'));
    ok('bot: polling');

    telegram.deliver('/start', NEW_USER);
    await until('the reply to /start', () =>
      telegram.calls.some((call) => call.method === 'sendMessage' && call.body.chat_id === NEW_USER),
    );
    // The reply goes out inside the update's transaction, which commits when the handler returns
    await until(
      'the user row',
      async () => (await sql`select 1 from users where telegram_id = ${NEW_USER}`).length > 0,
    );
    ok('bot: /start went through the chain, wrote the user row and answered');

    telegram.deliver('/stats', OWNER);
    await until('the owner digest', () =>
      telegram.calls.some((call) => call.method === 'sendRichMessage' && call.body.chat_id === OWNER),
    );
    ok('bot: /stats answered the owner');
  });
  await sql.end();
}

async function main() {
  const admin = postgres({
    ...settings.db,
    database: 'postgres',
    username: settings.db.user,
    max: 1,
    onnotice: () => {},
  });
  const [exists] = await admin`select 1 from pg_database where datname = ${DATABASE}`;
  if (!exists) await admin.unsafe(`create database "${DATABASE}"`);
  await admin.end();
  await runMigrations(settings.db);

  const build = spawnSync('bun', ['run', 'build'], { stdio: 'pipe' });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr}`);

  const telegram = fakeTelegram();
  await new Promise<void>((done) => telegram.server.listen(0, '127.0.0.1', done));
  const env = { SMOKE_TELEGRAM_PORT: String((telegram.server.address() as AddressInfo).port) };
  const preload = resolve('scripts/smoke/telegram-redirect.mjs');

  const runtimes = {
    bun: (entry: string) => ['bun', '--preload', preload, entry],
    node: (_: string, built: string) => ['node', '--import', preload, built],
  };
  for (const [name, command] of Object.entries(runtimes)) {
    console.log(`\n${name}`);
    await api(command('src/server/runtime/main.bun.ts', 'dist/main.node.js'), env);
    telegram.calls.length = 0;
    await worker(command('src/server/worker/main.ts', 'dist/worker.node.js'), env, telegram);
    telegram.calls.length = 0;
    await bot(command('src/server/bot/main.ts', 'dist/bot.node.js'), env, telegram);
    telegram.calls.length = 0;
  }

  telegram.server.close();
  console.log('\nAll checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
