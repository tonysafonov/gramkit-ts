import { describe, expect, it } from 'vitest';
import { PasswordService } from './password';

const service = new PasswordService();

describe('hashing and verifying', () => {
  it('hashPassword returns a bcrypt hash', async () => {
    // Python's test expects `$argon2id$`; this port uses bcrypt (docs/PORT-PLAN.md).
    expect(await service.hashPassword('MyPassword123')).toMatch(/^\$2[aby]\$/);
  });

  it('hashPassword produces different hashes for the same password', async () => {
    const hash1 = await service.hashPassword('SamePassword123');
    const hash2 = await service.hashPassword('SamePassword123');
    expect(hash1).not.toBe(hash2);
  });

  it('verifyPassword is true for the correct password', async () => {
    const hash = await service.hashPassword('MySecurePass123!');
    expect(await service.verifyPassword('MySecurePass123!', hash)).toBe(true);
  });

  it('verifyPassword is false for a wrong password', async () => {
    const hash = await service.hashPassword('CorrectPassword123');
    expect(await service.verifyPassword('WrongPassword123', hash)).toBe(false);
  });

  it('verifyPassword is false for an invalid hash format', async () => {
    expect(await service.verifyPassword('password', 'invalid_hash')).toBe(false);
  });

  it('verifyPassword is false for an empty hash', async () => {
    expect(await service.verifyPassword('password', '')).toBe(false);
  });

  it('verifyPassword works with an empty password', async () => {
    const hash = await service.hashPassword('');
    expect(await service.verifyPassword('', hash)).toBe(true);
    expect(await service.verifyPassword('notempty', hash)).toBe(false);
  });

  it('every character counts, past the 72 bytes bcrypt reads', async () => {
    const hash = await service.hashPassword(`${'A'.repeat(100)}1`);
    expect(await service.verifyPassword(`${'A'.repeat(100)}1`, hash)).toBe(true);
    expect(await service.verifyPassword(`${'A'.repeat(100)}2`, hash)).toBe(false);
  });
});

describe('validateStrength', () => {
  it.each([
    // Length checks
    ['short', false, 'too short (less than 8 chars)'],
    [`${'a'.repeat(129)}`, false, 'too long (over 128 chars)'],
    // Must have at least one of uppercase, digit or special
    ['alllowercase', false, 'lowercase only - no complexity'],
    ['a'.repeat(128), false, 'max length lowercase only - no complexity'],
    ['ALLUPPERCASE', true, 'has uppercase'],
    ['A'.repeat(128), true, 'max length with uppercase'],
    ['Password', true, 'has uppercase'],
    ['12345678', true, 'has digits'],
    ['password1', true, 'has digit'],
    ['pass word1', true, 'has digit with space'],
    ['password!', true, 'has special character'],
    ['Password1', true, 'has uppercase and digit'],
    ['PASSWORD1', true, 'has uppercase and digit'],
  ])('%s', (password, expectedValid, reason) => {
    const [isValid] = service.validateStrength(password);
    expect(isValid, reason).toBe(expectedValid);
  });

  it('returns a descriptive error message', () => {
    const [isValid, errorMessage] = service.validateStrength('short');
    expect(isValid).toBe(false);
    expect(errorMessage).toContain('8 characters');
  });

  it('returns no error message for a valid password', () => {
    expect(service.validateStrength('ValidPass123!')).toEqual([true, null]);
  });
});

describe('generateVerificationCode', () => {
  it('returns 6 digits', () => {
    expect(service.generateVerificationCode()).toMatch(/^\d{6}$/);
  });

  it('pads with leading zeros', () => {
    const codes = Array.from({ length: 1000 }, () => service.generateVerificationCode());
    expect(codes.every((code) => /^\d{6}$/.test(code))).toBe(true);
  });

  it('is random', () => {
    const codes = new Set(Array.from({ length: 100 }, () => service.generateVerificationCode()));
    expect(codes.size).toBe(100);
  });
});
