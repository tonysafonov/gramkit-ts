/**
 * Referral codes (a link's `r-<code>` / `?start=<code>`) and which ones mean acquisition. A code in a link is stored
 * as the user's first-touch source (`users.referral_code`). Codes on the app's own links to users it already has say
 * what brought a user back, not where they came from: they're listed here and never stored as a source.
 */
export const INTERNAL_REFERRAL_CODES: ReadonlySet<string> = new Set(['dailynotification']);
