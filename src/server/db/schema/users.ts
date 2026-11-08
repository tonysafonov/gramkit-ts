import { bigint, boolean, date, index, integer, jsonb, pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { createdAt, timestamptz, updatedAt } from './columns';
import { enumValues, UserRole, UserType } from './enums';

export const users = pgTable(
  'users',
  {
    // Core identity
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userType: varchar('user_type', { length: 10, enum: enumValues(UserType) })
      .notNull()
      .$default(() => UserType.REGISTERED),
    // varchar(20), not an enum column in Python either: `role` is a plain String there
    role: varchar('role', { length: 20 })
      .notNull()
      .$default(() => UserRole.USER),

    // App profile (user-controlled)
    displayName: varchar('display_name', { length: 255 }),
    username: varchar('username', { length: 128 }),
    avatarUrl: varchar('avatar_url', { length: 500 }),
    languageCode: varchar('language_code', { length: 10 }),
    timezone: varchar('timezone', { length: 50 }).$default(() => 'Europe/Moscow'),
    birthDate: date('birth_date', { mode: 'string' }),
    male: boolean('male'),

    // Auth: Telegram (read-only from the TG API)
    telegramId: bigint('telegram_id', { mode: 'number' }),
    tgFirstName: varchar('tg_first_name', { length: 64 }),
    tgLastName: varchar('tg_last_name', { length: 64 }),
    tgUsername: varchar('tg_username', { length: 32 }),
    tgLanguageCode: varchar('tg_language_code', { length: 8 }),
    tgIsPremium: boolean('tg_is_premium'),
    tgPhotoUrl: varchar('tg_photo_url', { length: 500 }),
    tgIsBot: boolean('tg_is_bot'),
    tgAddedToAttachmentMenu: boolean('tg_added_to_attachment_menu'),
    tgAllowsWriteToPm: boolean('tg_allows_write_to_pm'),

    // Auth: email
    email: varchar('email', { length: 255 }),
    emailVerified: boolean('email_verified').notNull().default(false),
    emailVerifiedAt: timestamptz('email_verified_at'),
    passwordHash: varchar('password_hash', { length: 255 }),
    lastLoginAt: timestamptz('last_login_at'),

    // Engagement
    currentStreak: integer('current_streak')
      .notNull()
      .$default(() => 0),
    bestStreak: integer('best_streak')
      .notNull()
      .$default(() => 0),
    totalActiveDays: integer('total_active_days')
      .notNull()
      .$default(() => 0),
    lastActivityDate: date('last_activity_date', { mode: 'string' }),

    // Onboarding & referral
    isOnboarded: boolean('is_onboarded').$default(() => false),
    isTermsAccepted: boolean('is_terms_accepted').$default(() => false),
    referralCode: varchar('referral_code', { length: 40 }),

    // Set when a bot send fails with "forbidden" (the user blocked the bot or deleted the account); cleared on
    // /start and on app open. Scheduled notifications skip users with it set.
    botBlockedAt: timestamptz('bot_blocked_at'),

    // Feature-reveal tracking: `feature_key -> value`. Written only via PATCH /users/me/seen-features (atomic merge).
    seenFeatures: jsonb('seen_features').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ix_users_role').on(t.role),
    unique('users_telegram_id_key').on(t.telegramId),
    // Named by the rename migration, not by the model: these are the real names in a migrated database.
    unique('uq_users_email').on(t.email),
    unique('uq_users_username').on(t.username),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
