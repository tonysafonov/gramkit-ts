/** Runs before each test file: log lines go nowhere unless a test asks for them with `captureLogs()`. */
import { setLogStream } from '../lib/logging';

setLogStream({ write: () => {} });
