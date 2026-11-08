import { createHash, randomInt } from 'node:crypto';
import bcrypt from 'bcrypt';
import { getLogger } from '../../lib/logging';

const logger = getLogger('password');

/** The cost of `bcrypt`. `DUMMY_PASSWORD_HASH` in `service.ts` must have the same one. */
const BCRYPT_ROUNDS = 10;

/**
 * bcrypt reads only the first 72 bytes, and a password may have up to 128 characters: without this, two long
 * passwords that differ past byte 72 would verify as the same.
 */
const prehash = (password: string): string => createHash('sha256').update(password).digest('base64');

export class PasswordService {
  static readonly MIN_LENGTH = 8;
  static readonly MAX_LENGTH = 128;
  static readonly SPECIAL_CHARS = '!@#$%^&*()_+-=[]{}|;:,.<>?';

  hashPassword(password: string): Promise<string> {
    return bcrypt.hash(prehash(password), BCRYPT_ROUNDS);
  }

  /** Constant-time. `false` for a wrong password and for anything that isn't a bcrypt hash. */
  async verifyPassword(password: string, passwordHash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(prehash(password), passwordHash);
    } catch (err) {
      logger.warn({ err }, 'Password verification failed');
      return false;
    }
  }

  /** 8-128 characters with at least one uppercase letter, digit or special character. `[isValid, errorMessage]`. */
  validateStrength(password: string): [boolean, string | null] {
    const characters = [...password];
    if (characters.length < PasswordService.MIN_LENGTH) {
      return [false, `Password must be at least ${PasswordService.MIN_LENGTH} characters`];
    }
    if (characters.length > PasswordService.MAX_LENGTH) {
      return [false, `Password must be at most ${PasswordService.MAX_LENGTH} characters`];
    }

    const hasUpper = /\p{Lu}/u.test(password);
    const hasDigit = /\p{Nd}/u.test(password);
    const hasSpecial = characters.some((character) => PasswordService.SPECIAL_CHARS.includes(character));
    if (!hasUpper && !hasDigit && !hasSpecial) {
      return [false, 'Password must contain at least one uppercase letter, number, or special character'];
    }
    return [true, null];
  }

  /** A 6-digit code, leading zeros kept. */
  generateVerificationCode(): string {
    return String(randomInt(1_000_000)).padStart(6, '0');
  }
}

export const passwordService = new PasswordService();
