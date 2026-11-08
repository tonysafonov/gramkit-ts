import { setLogStream } from '../lib/logging';

export interface LogLine {
  level: number;
  name?: string;
  msg: string;
  req?: string;
  user?: string;
  [key: string]: unknown;
}

const INFO = 30;

/** Collects log lines until `stop()`. */
export function captureLogs() {
  const lines: LogLine[] = [];
  const stop = setLogStream({ write: (line) => void lines.push(JSON.parse(line) as LogLine) });
  return {
    lines,
    /** The access-log lines, one per request. */
    accessLines: () => lines.filter((line) => line.name === 'core.access' && line.level === INFO),
    clear: () => {
      lines.length = 0;
    },
    stop,
  };
}
