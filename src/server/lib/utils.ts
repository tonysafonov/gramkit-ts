/** Normalize an email for consistent storage and lookup: trimmed, lowercase. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
