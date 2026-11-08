import { RedisClient } from '../../clients/redis';

interface Entry {
  value: string;
  expiresAt: number | null;
}

/** In-memory Redis with the operations the services use. Never connects. */
export class FakeRedis extends RedisClient {
  private readonly data = new Map<string, Entry>();

  private entry(key: string): Entry | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return null;
    }
    return entry;
  }

  override async get(key: string): Promise<string | null> {
    return this.entry(key)?.value ?? null;
  }

  override async set(key: string, value: string, ex?: number): Promise<boolean> {
    this.data.set(key, { value, expiresAt: ex ? Date.now() + ex * 1000 : null });
    return true;
  }

  override async delete(key: string): Promise<number> {
    return this.data.delete(key) ? 1 : 0;
  }

  override async exists(key: string): Promise<number> {
    return this.entry(key) ? 1 : 0;
  }

  override async incr(key: string): Promise<number> {
    return this.add(key, 1);
  }

  override async decr(key: string): Promise<number> {
    return this.add(key, -1);
  }

  private add(key: string, delta: number): number {
    const entry = this.entry(key);
    const value = Number(entry?.value ?? 0) + delta;
    this.data.set(key, { value: String(value), expiresAt: entry?.expiresAt ?? null });
    return value;
  }

  override async expire(key: string, seconds: number): Promise<boolean> {
    const entry = this.entry(key);
    if (!entry) return false;
    entry.expiresAt = Date.now() + seconds * 1000;
    return true;
  }

  override async flushdb(): Promise<boolean> {
    this.data.clear();
    return true;
  }

  override async close(): Promise<void> {
    this.data.clear();
  }

  clear(): void {
    this.data.clear();
  }
}
