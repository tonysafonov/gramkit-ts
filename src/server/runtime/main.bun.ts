import { createDemoSocketServer } from '../modules/demo/socket';
import { runBun } from './serve.bun';

runBun(async () => (await import('../api')).createAppApi(), { socketIo: () => createDemoSocketServer() });
