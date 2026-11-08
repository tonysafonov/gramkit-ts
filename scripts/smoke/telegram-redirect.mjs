// Loaded before an entry point (`--import` / `--preload`): sends every Bot API call to the smoke test's fake server, so
// nothing reaches Telegram. grammY takes `fetch` from this one module on both runtimes; on Bun `node-fetch` is built in,
// and neither `https.request` nor `globalThis.fetch` sees its requests.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shim = require.resolve('../../node_modules/grammy/out/shim.node.js');
const port = process.env.SMOKE_TELEGRAM_PORT;
if (!port) throw new Error('SMOKE_TELEGRAM_PORT is not set');

const redirected = (url, init) => {
  const { pathname } = new URL(url);
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
};

require.cache[shim] = {
  id: shim,
  filename: shim,
  loaded: true,
  exports: { fetch: redirected, AbortController },
};
