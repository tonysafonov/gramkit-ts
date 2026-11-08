import { type Channel, type ChannelModel, connect } from 'amqplib';
import { settings } from '../config';
import { getLogger } from '../lib/logging';

const logger = getLogger('rabbit');

/** A config holder until something is published: the connection opens on first use, and reopens if it was closed. */
export class RabbitProducer {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  /** The connect in progress: this client is shared, so concurrent first publishes must not each open one. */
  private connecting: Promise<void> | null = null;

  constructor(private readonly config: { url: string; queueName: string } = settings.rabbit) {}

  connect(): Promise<void> {
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<void> {
    logger.info('Connecting to RabbitMQ');
    try {
      const connection = await connect(this.config.url);
      const dropped = () => {
        this.connection = null;
        this.channel = null;
      };
      connection.on('close', dropped);
      connection.on('error', (err: Error) => logger.warn({ err }, 'RabbitMQ connection error'));
      const channel = await connection.createChannel();
      // Without a listener, a channel error is an uncaught exception: it would take the worker down.
      channel.on('error', (err: Error) => logger.warn({ err }, 'RabbitMQ channel error'));
      channel.on('close', () => {
        if (this.channel === channel) this.channel = null;
      });
      this.channel = channel;
      this.connection = connection;
    } catch (err) {
      logger.error({ err }, 'Failed to connect to RabbitMQ');
      throw err;
    }
  }

  async publish(message: Record<string, unknown>): Promise<void> {
    if (!this.channel) await this.connect();
    try {
      this.channel?.sendToQueue(this.config.queueName, Buffer.from(JSON.stringify(message)));
      logger.info(`Message published to queue ${this.config.queueName}`);
    } catch (err) {
      logger.error({ err }, 'Failed to publish message');
      throw err;
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.channel = null;
    if (!connection) return;
    try {
      await connection.close();
    } catch (err) {
      logger.error({ err }, 'Error closing RabbitMQ connection');
    }
  }
}
