import { z } from 'zod';
import { BackendException } from '../../lib/errors';
import type { UserSchema } from '../users/schemas';

/** What the email flows raise, Python's `ValueError("<code>")`. Routes turn it into an HTTP error. */
export type EmailAuthErrorCode =
  | 'rate_limited'
  | 'email_already_in_use'
  | 'email_already_verified'
  | 'signup_token_invalid'
  | 'signup_token_expired'
  | 'code_invalid'
  | 'code_expired'
  | 'password_too_weak'
  | 'invalid_credentials'
  | 'account_locked'
  | 'email_send_failed'
  | 'user_not_found'
  | 'reset_token_invalid';

export class EmailAuthException extends BackendException {
  constructor(readonly errorCode: EmailAuthErrorCode) {
    super(errorCode);
  }
}

const verificationCode = z
  .string()
  .min(6)
  .max(6)
  .regex(/^\d{6}$/);
const newPassword = z.string().min(8).max(128);

// Email auth ----------------------------------------------------------------------------------------------------

export const EmailCheckRequest = z.object({ email: z.email() });

export const EmailSignupRequest = z.object({ email: z.email() });

export const EmailSignupCompleteRequest = z.object({
  signup_token: z.string(),
  code: verificationCode,
  password: newPassword,
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/),
  language_code: z.string().max(10).nullish(),
});

export const EmailLoginRequest = z.object({
  email_or_username: z.string().min(3).max(255),
  password: z.string(),
});

export const EmailLinkRequest = z.object({ email: z.email() });

export const EmailLinkCompleteRequest = z.object({ code: verificationCode, password: newPassword });

/** For the signup flow. Without a token the session's user resends for the link flow. */
export const EmailResendRequest = z.object({ signup_token: z.string().nullish() });

export const PasswordResetStartRequest = z.object({ email: z.email() });

export const PasswordResetCompleteRequest = z.object({
  reset_token: z.string(),
  code: z.string(),
  new_password: z.string(),
});

// Telegram auth -------------------------------------------------------------------------------------------------

export const SendCodeRequest = z.object({ username: z.string() });

export const VerifyCodeRequest = z.object({ username: z.string(), code: z.string() });

export const DeeplinkPollQuery = z.object({ token: z.string() });

// Responses -----------------------------------------------------------------------------------------------------

type Identity = Pick<UserSchema, 'id' | 'username' | 'email'>;

export const toEmailSignupCompleteResponse = (user: Identity) => ({
  user_id: user.id,
  username: user.username,
  email: user.email,
  message: 'Account created successfully',
});

export const toEmailLoginResponse = (user: Identity) => ({
  user_id: user.id,
  username: user.username,
  email: user.email,
  message: 'Login successful',
});
