/**
 * Process-wide logging: pino, JSON lines to stdout, written asynchronously (sonic-boom) so a line never blocks the
 * event loop, as the Python app's QueueListener thread does. The request id and user come from the request context
 * through a mixin, on every line.
 *
 *     const logger = getLogger('payments');
 *     logger.info('Payment started');
 *     logger.error({ err }, 'Payment failed');
 *
 * Readable local logs: pipe through `pino-pretty` (`make dev` does).
 */
import pino, { type Logger } from 'pino';
import { settings } from '../config';
import { getRequestContext } from './request-context';

interface LogStream {
  write(line: string): void;
}

const stdout = pino.destination({ dest: 1, sync: false });
let target: LogStream = stdout;

export const rootLogger = pino(
  {
    level: settings.logLevel,
    base: undefined,
    mixin() {
      const ctx = getRequestContext();
      return ctx ? { req: ctx.requestId, user: ctx.userId } : {};
    },
  },
  { write: (line: string) => target.write(line) },
);

export const getLogger = (name: string): Logger => rootLogger.child({ name });

/** Send log lines somewhere else (tests read them). Returns the function that puts the previous target back. */
export function setLogStream(stream: LogStream): () => void {
  const previous = target;
  target = stream;
  return () => {
    target = previous;
  };
}

/** Write out every buffered line. Runs last on shutdown; later lines still go out. */
export function flushLogs(): void {
  try {
    stdout.flushSync();
  } catch {
    // Nothing queued, or stdout is already gone: nothing else can be written anyway.
  }
}

export type { Logger };
