import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { settings } from '../config';
import { generateTelegramInitData } from '../testing';
import { generateSecretKey, InvalidInitDataError, TelegramAuthenticator } from './telegram';

describe('TelegramAuthenticator', () => {
  const auth = new TelegramAuthenticator(generateSecretKey(settings.bot.token));

  it('returns the user signed into initData', () => {
    const initData = generateTelegramInitData({ userId: 42, username: 'anna', firstName: 'Анна', isPremium: true });

    expect(auth.verifyToken(initData)).toMatchObject({
      id: 42,
      firstName: 'Анна',
      username: 'anna',
      languageCode: 'en',
      isPremium: true,
    });
  });

  it('rejects a forged signature', () => {
    const initData = generateTelegramInitData({ userId: 42, username: 'anna', botToken: 'another:token' });

    expect(() => auth.verifyToken(initData)).toThrow(InvalidInitDataError);
  });

  it('rejects tampered data', () => {
    const initData = generateTelegramInitData({ userId: 42, username: 'anna' });

    expect(() => auth.verifyToken(initData.replace('anna', 'bob'))).toThrow(InvalidInitDataError);
  });

  describe('auth_date', () => {
    const now = () => Math.floor(Date.now() / 1000);
    const signed = (authDate: number) => generateTelegramInitData({ userId: 42, username: 'anna', authDate });

    it('accepts initData within the max age', () => {
      expect(auth.verifyToken(signed(now() - 86_000)).id).toBe(42);
    });

    it('rejects initData older than the max age: a leaked one does not log in for good', () => {
      expect(() => auth.verifyToken(signed(now() - 86_500))).toThrow('Init data is outdated');
      expect(() => auth.verifyToken(signed(1640000000))).toThrow(InvalidInitDataError);
    });

    it('rejects an auth_date in the future beyond the clock skew, allows a little', () => {
      expect(auth.verifyToken(signed(now() + 60)).id).toBe(42);
      expect(() => auth.verifyToken(signed(now() + 3600))).toThrow('in the future');
    });

    it('rejects signed initData with no auth_date, or a garbage one', () => {
      const user = JSON.stringify({ id: 42, first_name: 'Anna' });
      const sign = (fields: Record<string, string>) => {
        const check = Object.entries(fields)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, value]) => `${key}=${value}`)
          .join('\n');
        const hash = createHmac('sha256', generateSecretKey(settings.bot.token)).update(check).digest('hex');
        return new URLSearchParams({ ...fields, hash }).toString();
      };

      expect(() => auth.verifyToken(sign({ user }))).toThrow('no valid auth_date');
      expect(() => auth.verifyToken(sign({ user, auth_date: 'soon' }))).toThrow('no valid auth_date');
    });

    it('a max age of 0 checks nothing, as Python', () => {
      const forever = new TelegramAuthenticator(generateSecretKey(settings.bot.token), 0);
      expect(forever.verifyToken(signed(1640000000)).id).toBe(42);
    });
  });

  it.each([
    ['empty', ''],
    ['no hash', 'user=%7B%7D&auth_date=1'],
    ['garbage', '%%%'],
    ['non-ASCII hash', 'user=x&hash=%D1%84'],
  ])('rejects %s initData', (_, initData) => {
    expect(() => auth.verifyToken(initData)).toThrow(InvalidInitDataError);
  });
});
