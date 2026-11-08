/**
 * RabbitMQ consumer (Python's `infrastructure/rabbit/consumer.py`): reads the queue the producer publishes to and hands
 * each message to a callback. Nothing in the app starts it yet, as in Python.
 *
 * Differences: the body is `JSON.parse`d (Python `eval`s it, a hole the comment there already doubts); amqplib doesn't
 * reconnect on its own as aio_pika's `connect_robust` does, so a dropped connection ends `startConsuming`'s wait.
 */
import { type Channel, type ChannelModel, type ConsumeMessage, connect } from 'amqplib';
import type { Bot } from 'grammy';
import { getLogger } from '../lib/logging';

const logger = getLogger('rabbit-consumer');

export type MessageCallback = (bot: Bot | null, data: Record<string, unknown>) => unknown;

export class RabbitMQConsumer {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private bot: Bot | null = null;

  constructor(private readonly config: { url: string; queueName: string }) {}

  async connect(): Promise<void> {
    logger.info('Connecting to RabbitMQ');
    this.connection = await connect(this.config.url);
    this.channel = await this.connection.createChannel();
    await this.channel.assertQueue(this.config.queueName, { durable: true });
    logger.info(`Successfully connected to RabbitMQ and declared queue ${this.config.queueName}`);
  }

  /** Consume until the connection closes. */
  async consume(callback: MessageCallback): Promise<void> {
    const { channel, connection } = this;
    if (!channel || !connection) throw new Error('Not connected: call connect() first');

    const processMessage = async (message: ConsumeMessage | null) => {
      if (!message) return;
      const body = message.content.toString();
      logger.debug(`Received message: ${body}`);
      try {
        const data = JSON.parse(body) as Record<string, unknown>;
        await callback(this.bot, data);
        logger.info(`Successfully processed message: ${body}`);
      } catch (err) {
        logger.error({ err }, `Error processing message ${body}: ${err instanceof Error ? err.message : err}`);
      }
      // Acked either way (aio_pika's `message.process()`): a poison message must not come back forever
      channel.ack(message);
    };

    logger.info(`Starting to consume messages from queue ${this.config.queueName}`);
    await channel.consume(this.config.queueName, (message) => void processMessage(message));
    await new Promise<void>((resolve) => connection.once('close', resolve));
  }

  async startConsuming(callback: MessageCallback, bot: Bot | null): Promise<void> {
    this.bot = bot;
    await this.connect();
    await this.consume(callback);
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.channel = null;
    if (!connection) return;
    logger.info('Closing RabbitMQ connection');
    await connection.close();
    logger.info('RabbitMQ connection closed successfully');
  }
}
