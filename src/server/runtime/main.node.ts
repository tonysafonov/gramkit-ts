import { createDemoSocketServer } from '../modules/demo/socket';
import { runNode } from './serve.node';

runNode(async () => (await import('../api')).createAppApi(), { socketIo: () => createDemoSocketServer() });
