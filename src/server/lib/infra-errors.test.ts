import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { isInfrastructureError } from './infra-errors';

const coded = (code: string) => Object.assign(new Error('failed'), { code });

describe('isInfrastructureError', () => {
  it.each([
    ['refused connection', coded('ECONNREFUSED')],
    ['DNS failure', coded('EAI_AGAIN')],
    ['postgres.js closed connection', coded('CONNECTION_CLOSED')],
    ['a full pool', coded('QUEUE_TIMEOUT')],
    ['too many clients', coded('53300')],
    ['server shutting down', coded('57P01')],
    ['connection failure', coded('08006')],
    ['redis gave up', Object.assign(new Error('x'), { name: 'MaxRetriesPerRequestError' })],
    ['redis connection closed', new Error('Connection is closed.')],
    ['a timeout', Object.assign(new Error('x'), { name: 'TimeoutError' })],
  ])('counts %s', (_, error) => {
    expect(isInfrastructureError(error)).toBe(true);
  });

  it('finds the driver error Drizzle wrapped', () => {
    const wrapped = new DrizzleQueryError('select 1', [], coded('ECONNRESET') as Error);

    expect(isInfrastructureError(wrapped)).toBe(true);
  });

  it.each([
    ['a plain bug', new Error('boom')],
    ['a unique violation', coded('23505')],
    ['a missing file', coded('ENOENT')],
    ['a permission error', coded('EACCES')],
    ['not an error', 'nope'],
    ['nothing', null],
  ])('does not count %s', (_, error) => {
    expect(isInfrastructureError(error)).toBe(false);
  });

  it('survives a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;

    expect(isInfrastructureError(a)).toBe(false);
  });
});
