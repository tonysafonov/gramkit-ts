/** Verification emails through Resend's HTTP API. */
import { settings } from '../../config';
import { getLogger } from '../../lib/logging';
import { esc } from '../messages/admin-messages';

const logger = getLogger('auth');

const RESEND_API_URL = 'https://api.resend.com/emails';
/** Resend's onboarding sender: works while the configured domain isn't verified. */
const RESEND_ONBOARDING_ADDRESS = 'onboarding@resend.dev';
/** The request runs inside the HTTP request's transaction, so it can't hang for long. */
const SEND_TIMEOUT_MS = 30_000;

/**
 * The name is escaped: it is the user's own display name, which they set to anything, and the address is any one they
 * type in, so raw it would let anyone mail their HTML from the app's sender. Python puts it in raw.
 */
export function buildEmailHtml(code: string, firstName?: string | null): string {
  const greeting = firstName ? `Hi ${esc(firstName)},` : 'Hi,';

  return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #333; margin-bottom: 24px;">Verify your email</h2>

            <p style="color: #666; font-size: 16px;">${greeting}</p>

            <p style="color: #666; font-size: 16px;">Your verification code is:</p>

            <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 24px; background: #f5f5f5; text-align: center; border-radius: 8px; margin: 24px 0;">
                ${code}
            </div>

            <p style="color: #999; font-size: 14px;">This code expires in 10 minutes.</p>

            <p style="color: #999; font-size: 14px;">If you didn't request this code, you can safely ignore this email.</p>
        </body>
        </html>
        `;
}

/** Resolves to the message id; rejects with Resend's own message. */
async function postEmail(from: string, to: string, html: string): Promise<string | undefined> {
  const { apiKey, fromName } = settings.email;
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to], subject: 'Your verification code', html }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) throw new Error(body.message ?? `Resend answered ${response.status}`);
  return body.id;
}

/** Send a verification code. The configured address first, Resend's own when that domain isn't verified. */
export async function sendVerificationEmail(
  toEmail: string,
  code: string,
  firstName?: string | null,
): Promise<boolean> {
  const { apiKey, fromAddress } = settings.email;
  if (!apiKey) {
    logger.error('Email not configured - cannot send verification email');
    return false;
  }

  const html = buildEmailHtml(code, firstName);
  const masked = `${toEmail.slice(0, 3)}***@***`;
  const fromAddresses =
    fromAddress === RESEND_ONBOARDING_ADDRESS ? [fromAddress] : [fromAddress, RESEND_ONBOARDING_ADDRESS];

  for (const from of fromAddresses) {
    try {
      const id = await postEmail(from, toEmail, html);
      logger.info(`Verification email sent to ${masked}, id=${id}, from=${from}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('domain is not verified') && from !== RESEND_ONBOARDING_ADDRESS) {
        logger.warn(`Domain not verified for ${from}, falling back to ${RESEND_ONBOARDING_ADDRESS}`);
        continue;
      }
      logger.error({ err }, `Failed to send verification email to ${masked}`);
      return false;
    }
  }
  return false;
}
