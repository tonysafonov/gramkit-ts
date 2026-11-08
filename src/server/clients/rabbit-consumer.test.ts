/** The consumer against a fake amqplib: no broker is needed, the queue is what the test pushes through. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (message: { content: Buffer } | null) => void;

const broker = vi.hoisted(() => ({
  handler: null as null | ((message: { content: Buffer } | null) => void),
  acked: [] as unknown[],
  asserted: [] as unknown[],
  connection: null as null | { emit(event: string): boolean; close: () => Promise<void> },
}));

vi.mock('amqplib', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    connect: async () => {
      const connection = Object.assign(new EventEmitter(), {
        createChannel: async () => ({
          assertQueue: async (...args: unknown[]) => void broker.asserted.push(args),
          consume: async (_queue: string, handler: Handler) => void (broker.handler = handler),
          ack: (message: unknown) => void broker.acked.push(message),
        }),
        close: async () => void connection.emit('close'),
      });
      broker.connection = connection;
      return connection;
    },
  };
});

const { RabbitMQConsumer } = await import('./rabbit-consumer');

const message = (body: string) => ({ content: Buffer.from(body) });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  broker.handler = null;
  broker.acked.length = 0;
  broker.asserted.length = 0;
});

describe('RabbitMQConsumer', () => {
  it('declares a durable queue and passes each parsed message to the callback with the bot', async () => {
    const consumer = new RabbitMQConsumer({ url: 'amqp://x', queueName: 'jobs' });
    const callback = vi.fn();
    const bot = {} as never;
    const running = consumer.startConsuming(callback, bot);
    await settle();

    expect(broker.asserted).toEqual([['jobs', { durable: true }]]);
    const first = message('{"type":"welcome","user_id":7}');
    broker.handler?.(first);
    await settle();
    expect(callback).toHaveBeenCalledWith(bot, { type: 'welcome', user_id: 7 });
    expect(broker.acked).toEqual([first]);

    await consumer.close();
    await running;
  });

  it('acks a message whose callback throws, and keeps consuming', async () => {
    const consumer = new RabbitMQConsumer({ url: 'amqp://x', queueName: 'jobs' });
    const callback = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const running = consumer.startConsuming(callback, null);
    await settle();

    const bad = message('{"n":1}');
    const good = message('{"n":2}');
    broker.handler?.(bad);
    broker.handler?.(good);
    await settle();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(broker.acked).toEqual([bad, good]);

    await consumer.close();
    await running;
  });

  it('acks a message that is not JSON without calling the callback', async () => {
    const consumer = new RabbitMQConsumer({ url: 'amqp://x', queueName: 'jobs' });
    const callback = vi.fn();
    const running = consumer.startConsuming(callback, null);
    await settle();

    const junk = message('not json');
    broker.handler?.(junk);
    await settle();
    expect(callback).not.toHaveBeenCalled();
    expect(broker.acked).toEqual([junk]);

    await consumer.close();
    await running;
  });

  it('consume() before connect() fails', async () => {
    await expect(new RabbitMQConsumer({ url: 'amqp://x', queueName: 'jobs' }).consume(vi.fn())).rejects.toThrow(
      'Not connected',
    );
  });
});
