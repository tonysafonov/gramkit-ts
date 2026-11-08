import { HttpError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { telegramRetry } from './bot';

type Prev = Parameters<ReturnType<typeof telegramRetry>>[0];

const ok = { ok: true as const, result: true };
const failure = (error_code: number, retry_after?: number) => ({
  ok: false as const,
  error_code,
  description: 'failed',
  parameters: retry_after === undefined ? {} : { retry_after },
});

/** The transformer with no waiting, against a `prev` that answers with `responses` in turn. */
function run(responses: unknown[], method = 'sendMessage') {
  const prev = vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  const result = telegramRetry({ baseDelay: 0, maxRetryAfter: 1 })(
    prev as unknown as Prev,
    method as never,
    {} as never,
  );
  return { prev, result };
}

describe('telegramRetry', () => {
  it('returns a success at once', async () => {
    const { prev, result } = run([ok]);

    expect(await result).toEqual(ok);
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it('retries a network error, up to three tries', async () => {
    const error = new HttpError('network', new Error('reset'));
    const { prev, result } = run([error, error, error]);

    await expect(result).rejects.toBe(error);
    expect(prev).toHaveBeenCalledTimes(3);
  });

  it('retries a Telegram 5xx until it works', async () => {
    const { prev, result } = run([failure(502), ok]);

    expect(await result).toEqual(ok);
    expect(prev).toHaveBeenCalledTimes(2);
  });

  it('waits out a short flood limit', async () => {
    const { prev, result } = run([failure(429, 0), ok]);

    expect(await result).toEqual(ok);
    expect(prev).toHaveBeenCalledTimes(2);
  });

  it('hands a long flood limit to the caller', async () => {
    const { prev, result } = run([failure(429, 60)]);

    expect(await result).toMatchObject({ ok: false, error_code: 429 });
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it('does not retry a client error', async () => {
    const { prev, result } = run([failure(403)]);

    expect(await result).toMatchObject({ ok: false, error_code: 403 });
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it('leaves getUpdates alone', async () => {
    const { prev, result } = run([failure(502)], 'getUpdates');

    expect(await result).toMatchObject({ error_code: 502 });
    expect(prev).toHaveBeenCalledTimes(1);
  });
});
