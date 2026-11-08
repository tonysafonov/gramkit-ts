import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, loadEnv } from 'vite';
import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { version } from '../../package.json';

// Run from the repo root: `vite --config src/web/vite.config.ts`
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    root: __dirname,
    base: env.VITE_BASE_PATH || '/',
    plugins: [
      vue(),
      tailwindcss(),
      sentryVitePlugin({
        org: env.VITE_SENTRY_ORG,
        project: env.VITE_SENTRY_PROJECT,
        authToken: env.VITE_SENTRY_AUTH_TOKEN,
        release: { name: version },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@core': path.resolve(__dirname, './src/core'),
        '@app': path.resolve(__dirname, './src/app'),
        '@server': path.resolve(__dirname, '../server'),
      },
    },
    server: {
      host: true,
      port: 5174,
      // `/api/*` goes to the backend with the prefix stripped (nginx does the same in production), so the browser
      // sees one origin and the session cookie works. Socket.IO goes through it too.
      proxy: {
        '/api': {
          target: env.DEV_API_URL || 'http://localhost:8000',
          changeOrigin: true,
          ws: true,
          rewrite: (p: string) => p.replace(/^\/api/, ''),
        },
      },
      allowedHosts: [
        'localhost',
        'nginx',
        ...(env.VITE_WEB_HOST ? [new URL(env.VITE_WEB_HOST).hostname] : []),
      ],
    },
    preview: { host: true, allowedHosts: true },
    build: {
      outDir: path.resolve(__dirname, '../../dist/web'),
      emptyOutDir: true,
      target: ['es2015', 'chrome87', 'safari13', 'firefox78', 'edge88'],
      sourcemap: process.env.NODE_ENV === 'production',
    },
  };
});
