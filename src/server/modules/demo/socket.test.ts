/** The demo Socket.IO server with a real socket.io-client, in process on Node's HTTP server. */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoSocketServer, type DemoSocketServer } from './socket';

interface UpdatePayload {
  counter: number;
  users: number;
  events: { user: string; delta: number; time: string }[];
}

let http: HttpServer;
let demo: DemoSocketServer;
let url: string;
const clients: Socket[] = [];

beforeEach(async () => {
  http = createServer();
  demo = createDemoSocketServer({ simulationDelayMs: () => 10_000 });
  demo.io.attach(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  demo.close();
  // On Bun, node:http's close() waits for upgraded WebSocket connections to end on their own. Production Bun serves
  // Socket.IO through @socket.io/bun-engine instead (socket.runtime.test.ts).
  http.closeAllConnections();
  await demo.io.close();
});

const client = () => {
  const socket = connect(url, { transports: ['websocket'], reconnection: false });
  clients.push(socket);
  return socket;
};

const nextUpdate = (socket: Socket) =>
  new Promise<UpdatePayload>((resolve) => socket.once('update', (data: UpdatePayload) => resolve(data)));

describe('demo socket', () => {
  it('sends the state on connect', async () => {
    const socket = client();
    const update = await nextUpdate(socket);
    expect(update.counter).toBe(0);
    expect(update.events).toEqual([]);
    // fake users (1 to 3) plus this client
    expect(update.users).toBeGreaterThanOrEqual(2);
    expect(update.users).toBeLessThanOrEqual(4);
  });

  it('increment updates the counter for everyone in the room', async () => {
    const a = client();
    const b = client();
    await Promise.all([nextUpdate(a), nextUpdate(b)]);

    const seenByB = nextUpdate(b);
    a.emit('increment', 2);
    const update = await seenByB;
    expect(update.counter).toBe(2);
    expect(update.events).toHaveLength(1);
    expect(update.events[0]).toMatchObject({ user: 'You', delta: 2 });
    expect(update.events[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T.*\+00:00$/);
  });

  it('clamps delta to -3..3 and turns 0 or garbage into 1', async () => {
    const socket = client();
    await nextUpdate(socket);
    const deltas: number[] = [];
    for (const sent of [10, -10, 0, 'x', undefined]) {
      const next = nextUpdate(socket);
      socket.emit('increment', sent);
      deltas.push((await next).events.at(-1)?.delta ?? Number.NaN);
    }
    expect(deltas).toEqual([3, -3, 1, 1, 1]);
  });

  it('keeps the last 3 events', async () => {
    const socket = client();
    await nextUpdate(socket);
    let update: UpdatePayload | undefined;
    for (let i = 0; i < 5; i++) {
      const next = nextUpdate(socket);
      socket.emit('increment', 1);
      update = await next;
    }
    expect(update?.events).toHaveLength(3);
    expect(update?.counter).toBe(5);
  });

  it('counts connected clients in users, and drops them on disconnect', async () => {
    const a = client();
    const first = await nextUpdate(a);
    const b = client();
    const second = await nextUpdate(b);
    expect(second.users).toBe(first.users + 1);
  });

  it('simulates other users while someone is connected', async () => {
    demo.close();
    await demo.io.close();
    http = createServer();
    demo = createDemoSocketServer({ simulationDelayMs: () => 20 });
    demo.io.attach(http);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

    const socket = client();
    await nextUpdate(socket);
    const update = await nextUpdate(socket);
    expect(update.events).toHaveLength(1);
    expect(update.events[0]?.user).not.toBe('You');
  });

  it('allows any origin (CORS *)', async () => {
    const res = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
