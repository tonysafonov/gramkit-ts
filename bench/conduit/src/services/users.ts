import bcrypt from 'bcrypt';
import { sign } from 'hono/jwt';
import { JWT_SECRET } from '../env';
import { NotFoundError, UnauthorizedError, UnprocessableError } from '../errors';
import { type ProfileOut, toProfile, toUser, type UpdateUser, type UserOut } from '../schemas';
import { BaseService, isIntegrityError } from './base';

const TOKEN_TTL_SECONDS = 30 * 24 * 3600;
const BCRYPT_COST = 10;
/** bcrypt's limit. Python's bcrypt 5 rejects longer passwords; this one would cut them silently. */
const BCRYPT_MAX_BYTES = 72;

export function newToken(userId: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: String(userId), iat: now, exp: now + TOKEN_TTL_SECONDS }, JWT_SECRET, 'HS256');
}

function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password) > BCRYPT_MAX_BYTES) throw new UnprocessableError('password is too long');
  return bcrypt.hash(password, BCRYPT_COST);
}

async function checkPassword(password: string, passwordHash: string): Promise<boolean> {
  if (Buffer.byteLength(password) > BCRYPT_MAX_BYTES) return false;
  return bcrypt.compare(password, passwordHash);
}

function rethrowTaken(err: unknown): never {
  if (isIntegrityError(err)) throw new UnprocessableError('username or email already taken');
  throw err;
}

export class ConduitUsersService extends BaseService {
  async register(username: string, email: string, password: string): Promise<UserOut> {
    const passwordHash = await hashPassword(password);
    const row = await this.repos.conduitUsers.register(username, email, passwordHash).catch(rethrowTaken);
    return toUser(row, await newToken(row.id));
  }

  async login(email: string, password: string): Promise<UserOut> {
    const row = await this.repos.conduitUsers.getForLogin(email);
    if (row === null || !(await checkPassword(password, row.passwordHash))) {
      throw new UnauthorizedError('invalid email or password');
    }
    return toUser(row, await newToken(row.id));
  }

  async current(userId: number, token: string): Promise<UserOut> {
    const row = await this.repos.conduitUsers.getRow(userId);
    if (row === null) throw new UnauthorizedError('user not found');
    return toUser(row, token);
  }

  async update(userId: number, token: string, data: UpdateUser): Promise<UserOut> {
    const passwordHash = data.password == null ? null : await hashPassword(data.password);
    const row = await this.repos.conduitUsers
      .updateFields(userId, data.email, data.username, passwordHash, data.bio, data.image)
      .catch(rethrowTaken);
    if (row === null) throw new UnauthorizedError('user not found');
    return toUser(row, token);
  }

  async profile(viewer: number, username: string): Promise<ProfileOut> {
    const row = await this.repos.conduitUsers.getProfile(viewer, username);
    if (row === null) throw new NotFoundError('profile not found');
    return toProfile(row, row.following);
  }

  async setFollow(viewer: number, username: string, follow: boolean): Promise<ProfileOut> {
    const row = await this.repos.conduitUsers.getByUsername(username);
    if (row === null) throw new NotFoundError('profile not found');
    if (follow) await this.repos.conduitUsers.follow(viewer, row.id);
    else await this.repos.conduitUsers.unfollow(viewer, row.id);
    return toProfile(row, follow);
  }
}
