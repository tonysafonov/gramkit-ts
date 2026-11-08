import { type PostHogClient, posthog } from '../../clients/posthog';

export interface CapturedEvent {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}

/** Collects events. `install()` puts it behind the process's `posthog`. */
export class FakePostHog implements PostHogClient {
  readonly events: CapturedEvent[] = [];
  readonly identified: { distinctId: string; properties?: Record<string, unknown> }[] = [];

  capture({ distinctId, event, properties = {} }: Parameters<PostHogClient['capture']>[0]): void {
    this.events.push({ distinctId, event, properties });
  }

  identify(message: Parameters<PostHogClient['identify']>[0]): void {
    this.identified.push(message);
  }

  shutdown(): void {}

  install(): this {
    posthog.useClient(this);
    return this;
  }
}
