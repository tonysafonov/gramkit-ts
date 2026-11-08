import { RabbitProducer } from '../../clients/rabbit';

/** Records messages instead of publishing them. */
export class FakeProducer extends RabbitProducer {
  readonly messages: Record<string, unknown>[] = [];

  override async connect(): Promise<void> {}

  override async publish(message: Record<string, unknown>): Promise<void> {
    this.messages.push(message);
  }

  override async close(): Promise<void> {}
}
