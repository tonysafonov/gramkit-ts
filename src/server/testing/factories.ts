import { randomBytes } from 'node:crypto';
import type { Db } from '../db/client';
import { balances, type NewUser, type User, users } from '../db/schema';

let sequence = 0;

/** A telegram id no other test in this file has. Files have their own database, so this only has to be unique here. */
export const nextTelegramId = (): number => {
  sequence += 1;
  return 1_000_000 + sequence;
};

/** A registered user with a unique identity. `overrides` are the row's own (camelCase) fields. */
export async function createUser(db: Db, overrides: Partial<NewUser> = {}): Promise<User> {
  const telegramId = overrides.telegramId === undefined ? nextTelegramId() : overrides.telegramId;
  const suffix = randomBytes(4).toString('hex');
  const [user] = await db
    .insert(users)
    .values({
      telegramId,
      displayName: `Test User ${suffix}`,
      username: `user_${suffix}`,
      languageCode: 'en',
      tgFirstName: 'Test',
      tgUsername: `tg_${suffix}`,
      tgLanguageCode: 'en',
      isOnboarded: true,
      isTermsAccepted: true,
      ...overrides,
    })
    .returning();
  if (!user) throw new Error('createUser: no row returned');
  return user;
}

/** A user with their balance row, as `getOrCreateUser` leaves them. */
export async function createUserWithBalance(db: Db, overrides: Partial<NewUser> = {}): Promise<User> {
  const user = await createUser(db, overrides);
  await db.insert(balances).values({ userId: user.id });
  return user;
}
