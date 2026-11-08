/**
 * What's missing or extra against the Python REST contract: `docs/python-contract/routes.txt` (every route of the
 * FastAPI app, from `scripts/python-routes.py`) against the routes mounted on the Hono app.
 *
 *     bun run route-parity
 *
 * Exits 1 on any difference, either way: a route Python has and this app doesn't, or the reverse.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.ENV_FILE ??= '.env.example';

/** Routes of the Hono app that are static files, which Python serves through a `/static` mount. */
const STATIC_ROUTE = /^GET \/static\//;

/** `METHOD /path/{param}` per line; `#` lines are comments. */
function contractRoutes(source: string): Set<string> {
  return new Set(source.split('\n').filter((line) => line && !line.startsWith('#')));
}

/** `/items/:id` → `/items/{id}`, the contract's spelling. */
const toContractPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');

async function mountedRoutes(): Promise<Set<string>> {
  const { createAppApi } = await import('../src/server/api');
  const api = createAppApi();
  const routes = new Set(
    api.app.routes
      .filter((route) => route.method !== 'ALL')
      .map((route) => `${route.method} ${toContractPath(route.path)}`)
      .filter((route) => !STATIC_ROUTE.test(route)),
  );
  await api.state.db.close();
  return routes;
}

const contract = contractRoutes(readFileSync(resolve('docs/python-contract/routes.txt'), 'utf8'));
const mounted = await mountedRoutes();

const missing = [...contract].filter((route) => !mounted.has(route)).sort();
const extra = [...mounted].filter((route) => !contract.has(route)).sort();

console.log(`Python: ${contract.size} routes. Mounted: ${mounted.size} routes.\n`);
console.log(`Missing (${missing.length}):`);
for (const route of missing) console.log(`  ${route}`);
console.log(`\nExtra (${extra.length}):`);
for (const route of extra) console.log(`  ${route}`);

process.exit(missing.length + extra.length > 0 ? 1 : 0);
