/**
 * The Node production build: one bundled file per entry in `dist/`, dependencies left external (native modules like
 * bcrypt can't be bundled). Bun needs no build, it runs the TypeScript source.
 *
 * `splitting`: without it esbuild hoists every package to the top of the bundle, so the cluster primary would load
 * what only the workers need.
 */
import { cp } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: {
    'main.node': 'src/server/runtime/main.node.ts',
    'bot.node': 'src/server/bot/main.ts',
    'worker.node': 'src/server/worker/main.ts',
    'scripts.node': 'src/server/scripts/main.ts',
    'migrate.node': 'src/server/db/migrate.ts',
  },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

// The bundled migrator looks next to itself
await cp('src/server/db/migrations', 'dist/migrations', { recursive: true });
