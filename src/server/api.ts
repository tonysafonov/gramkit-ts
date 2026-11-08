/** The application's API: Python's `app/webhook/app.py`. The bench builds its own from `createApi`. */
import { resolve } from 'node:path';
import pkg from '../../package.json';
import { createApi } from './app';
import { generateSecretKey, TelegramAuthenticator } from './auth/telegram';
import { settings } from './config';
import { setupRegistries } from './registries';
import { Repos } from './repos';
import { routes } from './routes';
import { Services } from './services';

export function createAppApi() {
  setupRegistries();
  return createApi({
    reposClass: Repos,
    servicesClass: Services,
    routes,
    title: 'Template API',
    version: pkg.version,
    staticPath: resolve('src/server/static'),
    rootPath: settings.web.apiRootPath,
    telegramAuth: new TelegramAuthenticator(generateSecretKey(settings.bot.token), settings.bot.initDataMaxAge),
    securityCsp:
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://js.posthog.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data: https:; " +
      `connect-src 'self' https://cdn.jsdelivr.net ${settings.web.apiUrl} https://api.posthog.com; ` +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'",
  });
}
