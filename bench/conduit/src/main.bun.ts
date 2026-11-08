import './env';
import { runBun } from '../../../src/server/runtime/serve.bun';

runBun(async () => (await import('./api')).createConduitApi());
