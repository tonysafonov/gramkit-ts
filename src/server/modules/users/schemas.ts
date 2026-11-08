import { z } from 'zod';
import type { Group } from '../../db/schema';
import { type User, UserRole, UserType } from '../../db/schema';

/** The user as the app handles it: the row without `passwordHash`, which never leaves the repo layer. */
export type UserSchema = Omit<User, 'passwordHash'>;

/** Strip the password hash off a row. Services return this, never the row. */
export function toUserSchema(row: User | UserSchema): UserSchema {
  const { passwordHash: _passwordHash, ...user } = row as User;
  return user;
}

/** The user hasn't had a first app session yet. State-based (`lastActivityDate`), not time-based: retries are safe. */
export const isNew = (user: Pick<UserSchema, 'lastActivityDate'>): boolean => user.lastActivityDate === null;
export const isGuest = (user: Pick<UserSchema, 'userType'>): boolean => user.userType === UserType.GUEST;
export const isRegisteredUser = (user: Pick<UserSchema, 'userType'>): boolean => user.userType === UserType.REGISTERED;
export const isAdmin = (user: Pick<UserSchema, 'role'>): boolean =>
  user.role === UserRole.ADMIN || user.role === UserRole.OWNER;
export const isOwner = (user: Pick<UserSchema, 'role'>): boolean => user.role === UserRole.OWNER;

/** Python's `GroupSchema`: a group with its members. */
export interface GroupSchema {
  id: number;
  title: string | null;
  photoUrl: string | null;
  users: UserSchema[];
}

export const toGroupSchema = (
  group: Pick<Group, 'id' | 'title' | 'photoUrl'>,
  users: UserSchema[] = [],
): GroupSchema => ({
  id: group.id,
  title: group.title,
  photoUrl: group.photoUrl,
  users,
});

// Wire shapes ---------------------------------------------------------------------------------------------------

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** The JSON of `UserSchema`: snake_case, every field, never `password_hash`. */
export function toUserResponse(user: UserSchema) {
  return {
    id: user.id,
    user_type: user.userType,
    role: user.role,
    created_at: iso(user.createdAt),
    updated_at: iso(user.updatedAt),
    display_name: user.displayName,
    username: user.username,
    avatar_url: user.avatarUrl,
    language_code: user.languageCode,
    timezone: user.timezone,
    birth_date: user.birthDate,
    male: user.male,
    telegram_id: user.telegramId,
    tg_first_name: user.tgFirstName,
    tg_last_name: user.tgLastName,
    tg_username: user.tgUsername,
    tg_language_code: user.tgLanguageCode,
    tg_is_premium: user.tgIsPremium,
    tg_photo_url: user.tgPhotoUrl,
    tg_is_bot: user.tgIsBot,
    tg_added_to_attachment_menu: user.tgAddedToAttachmentMenu,
    tg_allows_write_to_pm: user.tgAllowsWriteToPm,
    email: user.email,
    email_verified: user.emailVerified,
    email_verified_at: iso(user.emailVerifiedAt),
    last_login_at: iso(user.lastLoginAt),
    current_streak: user.currentStreak,
    best_streak: user.bestStreak,
    total_active_days: user.totalActiveDays,
    last_activity_date: user.lastActivityDate,
    is_onboarded: user.isOnboarded,
    is_terms_accepted: user.isTermsAccepted,
    referral_code: user.referralCode,
    bot_blocked_at: iso(user.botBlockedAt),
    seen_features: user.seenFeatures,
  };
}

export function toGroupResponse(group: GroupSchema) {
  return {
    id: group.id,
    title: group.title,
    photo_url: group.photoUrl,
    users: group.users.map(toUserResponse),
  };
}

// Requests ------------------------------------------------------------------------------------------------------

const isoDate = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)), {
  message: 'Input should be a valid date or datetime, invalid character in year',
});

/** Body of `PATCH /users/me`. A key that is absent stays untouched; an explicit `null` clears the column. */
export const UpdateUserBody = z.object({
  display_name: z.string().nullish(),
  username: z.string().nullish(),
  avatar_url: z.string().nullish(),
  language_code: z.string().nullish(),
  timezone: z.string().nullish(),
  birth_date: isoDate.nullish(),
  male: z.boolean().nullish(),
  is_onboarded: z.boolean().nullish(),
  is_terms_accepted: z.boolean().nullish(),
});
export type UpdateUserBody = z.infer<typeof UpdateUserBody>;

/** What `UsersService.updateUser` takes: the body's fields in camelCase, only those that were sent. */
export interface UpdateUserRequest {
  displayName?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  languageCode?: string | null;
  timezone?: string | null;
  birthDate?: string | null;
  male?: boolean | null;
  isOnboarded?: boolean | null;
  isTermsAccepted?: boolean | null;
}

const UPDATE_FIELDS = {
  display_name: 'displayName',
  username: 'username',
  avatar_url: 'avatarUrl',
  language_code: 'languageCode',
  timezone: 'timezone',
  birth_date: 'birthDate',
  male: 'male',
  is_onboarded: 'isOnboarded',
  is_terms_accepted: 'isTermsAccepted',
} as const satisfies Record<keyof UpdateUserBody, keyof UpdateUserRequest>;

export function toUpdateUserRequest(body: UpdateUserBody): UpdateUserRequest {
  const request: Record<string, unknown> = {};
  for (const [wire, field] of Object.entries(UPDATE_FIELDS)) {
    const value = body[wire as keyof UpdateUserBody];
    if (value !== undefined) request[field] = value;
  }
  return request as UpdateUserRequest;
}

// Feature-seen tracking -----------------------------------------------------------------------------------------

const FEATURE_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
export const MAX_FEATURE_KEYS = 20;

const featureScalar = z.union([z.boolean(), z.number(), z.string()]);
/** A scalar (one-shot bool, version number) or a shallow record of scalars: one level deep, no further. */
const featureValue = z.union([featureScalar, z.record(z.string(), featureScalar)]);

/**
 * Body of `PATCH /users/me/seen-features`: a shallow `feature_key -> value` map, merged into `users.seen_features` via
 * JSONB `||` (top-level keys only). Hardened because it is user-writable: keys are dotted lowercase identifiers, the map
 * is bounded, values are at most one level deep.
 */
export const SeenFeaturesPatch = z.record(z.string(), featureValue).superRefine((value, ctx) => {
  const keys = Object.keys(value);
  if (keys.length === 0)
    ctx.addIssue({ code: 'custom', message: 'Value error, patch must contain at least one feature key' });
  if (keys.length > MAX_FEATURE_KEYS) {
    ctx.addIssue({ code: 'custom', message: `Value error, too many feature keys (max ${MAX_FEATURE_KEYS})` });
  }
  for (const key of keys) {
    if (!FEATURE_KEY_RE.test(key))
      ctx.addIssue({ code: 'custom', message: `Value error, invalid feature key: '${key}'` });
  }
});
export type SeenFeaturesPatch = z.infer<typeof SeenFeaturesPatch>;
