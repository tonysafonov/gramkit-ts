import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const env = process.env;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema/index.ts',
  out: './src/server/db/migrations',
  dbCredentials: {
    host: env.DB__HOST ?? 'localhost',
    port: Number(env.DB__PORT ?? 5460),
    user: env.DB__USER ?? 'postgres',
    password: env.DB__PASSWORD ?? 'postgres',
    database: env.DB__NAME ?? 'gramkit',
    ssl: false,
  },
});
