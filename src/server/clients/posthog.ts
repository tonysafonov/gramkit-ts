import { PostHog } from 'posthog-node';
import { getLogger } from '../lib/logging';

const logger = getLogger('posthog');

type Properties = Record<string, unknown>;

/** What the wrapper needs from a PostHog client; tests hand it a fake. */
export interface PostHogClient {
  capture(message: { distinctId: string; event: string; properties?: Properties }): void;
  identify(message: { distinctId: string; properties?: Properties }): void;
  shutdown(): Promise<void> | void;
}

/** PostHog with the Python wrapper's contract: a no-op when unconfigured, and analytics never raises into a request. */
export class PostHogWrapper {
  private client: PostHogClient | null = null;
  private superProperties: Properties = {};

  /** Configure the client. Without an API key or host, analytics stays disabled. */
  setup(apiKey: string, host: string, appVersion = ''): void {
    if (this.client) return;
    if (apiKey && host) {
      this.client = new PostHog(apiKey, { host });
    } else {
      logger.debug('PostHog API key or host not configured: analytics disabled');
    }
    if (appVersion) this.superProperties.$app_version = appVersion;
  }

  /** Use this client instead of a real one. */
  useClient(client: PostHogClient | null): void {
    this.client = client;
  }

  capture(distinctId: string, event: string, properties?: Properties): boolean {
    if (!this.client) return false;
    try {
      this.client.capture({ distinctId, event, properties: { ...this.superProperties, ...properties } });
      return true;
    } catch (err) {
      logger.error({ err }, `PostHog capture failed for event '${event}'`);
      return false;
    }
  }

  identify(distinctId: string, properties?: Properties): boolean {
    if (!this.client) return false;
    try {
      this.client.identify({ distinctId, properties });
      return true;
    } catch (err) {
      logger.error({ err }, `PostHog identify failed for user '${distinctId}'`);
      return false;
    }
  }

  /** Send what is queued and stop. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.shutdown();
  }
}

export const posthog = new PostHogWrapper();
