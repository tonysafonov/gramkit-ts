import './env';
import { runNode } from '../../../src/server/runtime/serve.node';

runNode(async () => (await import('./api')).createConduitApi());
