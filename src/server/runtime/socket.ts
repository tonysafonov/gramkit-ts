/** The hook an app gives the runtime to serve Socket.IO at `/socket.io`; each runtime binds its own transport. */
import type { Server } from 'socket.io';

export interface SocketHook {
  /** A Socket.IO server with no transport yet. */
  io: Server;
  /** Stop its background work and drop its clients (not the HTTP server). */
  close(): void;
}

export interface RuntimeOptions {
  /** Builds the app's Socket.IO server, once per worker. Without it nothing is served at `/socket.io`. */
  socketIo?: () => SocketHook;
}

export const SOCKET_IO_PATH = '/socket.io/';
