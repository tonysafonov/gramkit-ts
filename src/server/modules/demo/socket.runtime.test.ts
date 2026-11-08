/**
 * Socket.IO through the real runtime servers: `serve.node.ts` on Node and `serve.bun.ts` on Bun, each started as its
 * own process, with a real socket.io-client over polling, websocket and the upgrade between them.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const hasBun = spawnSync('bun', ['--version']).status === 0;
// Inside the repo: the bundle leaves packages external, and Node resolves them from the file's own directory
const cacheDir = join(ROOT, 'node_modules/.cache');
mkdirSync(cacheDir, { recursive: true });
const outdir = mkdtempSync(join(cacheDir, 'gramkit-socket-'));
const children: ChildProcess[] = [];

const freePort = () =>
  new Promise<number>((resolvePort) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });

async function start(command: string, args: string[], runtime: string): Promise<string> {
  const port = await freePort();
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ENV_FILE: '.env.test', PORT: String(port), HOST: '127.0.0.1', FIXTURE_RUNTIME: runtime },
    stdio: 'ignore',
  });
  children.push(child);
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(url);
      return url;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`${runtime} server did not start`);
}

beforeAll(async () => {
  await build({
    entryPoints: { fixture: join(ROOT, 'src/server/modules/demo/socket-fixture.ts') },
    outdir,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
}, 60_000);

afterAll(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(outdir, { recursive: true, force: true });
});

const runtimes = [
  { name: 'Node', skip: false, launch: () => start('node', [join(outdir, 'fixture.js')], 'node') },
  { name: 'Bun', skip: !hasBun, launch: () => start('bun', ['src/server/modules/demo/socket-fixture.ts'], 'bun') },
];

describe.each(runtimes)('Socket.IO on $name', ({ skip, launch }) => {
  let url = '';
  beforeAll(async () => {
    if (!skip) url = await launch();
  }, 30_000);

  const exchange = async (transports: ('polling' | 'websocket')[]) => {
    const socket = connect(url, { transports, reconnection: false });
    try {
      return await new Promise<{ first: { counter: number }; second: { counter: number }; transport: string }>(
        (resolvePair, reject) => {
          let first: { counter: number } | undefined;
          socket.on('connect_error', reject);
          socket.on('update', (data: { counter: number }) => {
            if (!first) {
              first = data;
              socket.emit('increment', 3);
            } else if (data.counter === first.counter + 3) {
              resolvePair({ first, second: data, transport: socket.io.engine.transport.name });
            }
          });
          setTimeout(() => reject(new Error('timeout')), 5000);
        },
      );
    } finally {
      socket.close();
    }
  };

  it.skipIf(skip)('connects over polling and round-trips an event', async () => {
    expect((await exchange(['polling'])).transport).toBe('polling');
  });

  it.skipIf(skip)('connects over websocket and round-trips an event', async () => {
    expect((await exchange(['websocket'])).transport).toBe('websocket');
  });

  it.skipIf(skip)('upgrades polling to websocket', async () => {
    const socket = connect(url, { transports: ['polling', 'websocket'], reconnection: false });
    const transport = await new Promise<string>((resolveName, reject) => {
      socket.io.engine?.on('upgrade', (t: { name: string }) => resolveName(t.name));
      socket.on('connect', () => socket.io.engine.on('upgrade', (t: { name: string }) => resolveName(t.name)));
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('no upgrade')), 5000);
    });
    socket.close();
    expect(transport).toBe('websocket');
  });

  it.skipIf(skip)('still serves the app for other paths', async () => {
    const res = await fetch(`${url}/anything`);
    expect(await res.text()).toBe('stub api');
  });
});
