/**
 * The demo's Socket.IO server (Python's `webhook/socketio` + core's `create_socketio`): a shared counter in the room
 * `demo`, plus simulated "other users" while anyone is connected. State is per process, as in Python. The runtime
 * attaches it at `/socket.io` (`runtime/serve.node.ts`, `serve.bun.ts`).
 */
import { Server } from 'socket.io';

const ROOM = 'demo';

const FAKE_USERNAMES = [
  'Alex',
  'Jordan',
  'Sam',
  'Charlie',
  'Morgan',
  'Riley',
  'Casey',
  'Quinn',
  'Avery',
  'Taylor',
  'Drew',
  'Jamie',
  'Skyler',
  'Reese',
  'Parker',
];

const MAX_EVENTS = 3;

interface DemoEvent {
  user: string;
  delta: number;
  time: string;
}

const pick = <T>(values: T[]): T => values[Math.floor(Math.random() * values.length)] as T;
const uniform = (a: number, b: number) => a + Math.random() * (b - a);

export interface DemoSocketOptions {
  /** Pause between simulated actions, in ms (Python: uniform 5 to 12 s). */
  simulationDelayMs?: () => number;
}

export interface DemoSocketServer {
  io: Server;
  /** Stop the simulation and drop every client. Does not close the HTTP server. */
  close(): void;
}

/**
 * A Socket.IO server not yet bound to a transport: `io.attach(httpServer)` on Node, `io.bind(engine)` on Bun.
 * CORS allows any origin, as Python's `cors_origins="*"`; ping timings are Python's too.
 */
export function createDemoSocketServer(options: DemoSocketOptions = {}): DemoSocketServer {
  const simulationDelayMs = options.simulationDelayMs ?? (() => uniform(5000, 12000));
  const io = new Server({ cors: { origin: '*' }, pingTimeout: 20_000, pingInterval: 25_000 });

  let counter = 0;
  let fakeUsers = 1 + Math.floor(Math.random() * 3);
  const recentEvents: DemoEvent[] = [];
  let simulation: NodeJS.Timeout | null = null;

  const demoUserCount = () => io.sockets.adapter.rooms.get(ROOM)?.size ?? 0;

  const state = () => ({ counter, users: fakeUsers + demoUserCount(), events: [...recentEvents] });

  const createEvent = (user: string, delta: number): DemoEvent => ({
    user,
    delta,
    time: new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00'),
  });

  const broadcastState = (event?: DemoEvent) => {
    if (event) {
      recentEvents.push(event);
      if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
    }
    io.to(ROOM).emit('update', state());
  };

  /** Simulate other users changing the counter, until the last client leaves. */
  const scheduleSimulation = () => {
    simulation = setTimeout(() => {
      const delta = pick([-3, -2, -1, 1, 2, 3]);
      counter += delta;
      fakeUsers = Math.max(1, Math.min(5, fakeUsers + pick([-1, 0, 0, 0, 1])));
      broadcastState(createEvent(pick(FAKE_USERNAMES), delta));
      scheduleSimulation();
    }, simulationDelayMs());
  };

  const stopSimulation = () => {
    if (simulation) clearTimeout(simulation);
    simulation = null;
  };

  io.on('connection', (socket) => {
    void socket.join(ROOM);
    if (!simulation) scheduleSimulation();
    socket.emit('update', state());

    socket.on('increment', (raw?: unknown) => {
      // `delta: int = 1`, clamped to -3..3, never 0
      const requested = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 1;
      const delta = Math.max(-3, Math.min(3, requested)) || 1;
      counter += delta;
      broadcastState(createEvent('You', delta));
    });

    // Already out of its rooms when this fires
    socket.on('disconnect', () => {
      if (demoUserCount() === 0) stopSimulation();
    });
  });

  return {
    io,
    close() {
      stopSimulation();
      io.disconnectSockets(true);
    },
  };
}
