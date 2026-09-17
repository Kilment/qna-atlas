import type { InstitutionalCodeType } from "@shared/schema";

export type { InstitutionalCodeType };

/** Built-in institutional code: full platform access with no expiry (redeemed via existing UI). */
export const SOCIALMEDIA_INSTITUTIONAL_CODE = "socialmedia";

/** Built-in trial codes: 30 days of access from redemption, once per account. */
export const IOWA_TRIAL_CODE = "IOWA-TRIAL";
export const TEMPLE_TRIAL_CODE = "TEMPLE-TRIAL";
export const NUMC_TRIAL_CODE = "NUMC-TRIAL";

/** One-time promo: 1 month of PRS Atlas access, redeemable a single time ever. */
export const PRSATLAS30_CODE = "PRSATLAS30";

const BUILTIN_TRIAL_CODES = [IOWA_TRIAL_CODE, TEMPLE_TRIAL_CODE, NUMC_TRIAL_CODE] as const;

export const INSTITUTIONAL_CODE_DURATION_DAYS = 365;
export const TRIAL_CODE_DURATION_DAYS = 30;
/** New codes cannot be redeemed after this many days from creation. */
export const CODE_REDEEM_WINDOW_DAYS = 90;

/** Sentinel end date for unlimited institutional access (year 2099). */
export const UNLIMITED_INSTITUTIONAL_EXPIRES_AT_ISO = "2099-12-31T23:59:59.999Z";

const UNLIMITED_INSTITUTIONAL_EXPIRES_AT_MS = new Date(
  UNLIMITED_INSTITUTIONAL_EXPIRES_AT_ISO
).getTime();

export function isInstitutionalCodeType(value: unknown): value is InstitutionalCodeType {
  return value === "institutional" || value === "trial";
}

export function parseInstitutionalCodeType(value: unknown): InstitutionalCodeType {
  return value === "trial" ? "trial" : "institutional";
}

export function isUnlimitedInstitutionalCode(plainCode: string): boolean {
  return plainCode.trim().toLowerCase() === SOCIALMEDIA_INSTITUTIONAL_CODE;
}

export function isBuiltinTrialCode(plainCode: string): boolean {
  const normalized = plainCode.trim().toUpperCase();
  return BUILTIN_TRIAL_CODES.includes(normalized as (typeof BUILTIN_TRIAL_CODES)[number]);
}

export function isPrsAtlas30Code(plainCode: string): boolean {
  return plainCode.trim().toUpperCase() === PRSATLAS30_CODE;
}

export function normalizeInstitutionalCodeForLookup(plainCode: string): string {
  const trimmed = plainCode.trim();
  if (isUnlimitedInstitutionalCode(trimmed)) return SOCIALMEDIA_INSTITUTIONAL_CODE;
  if (isBuiltinTrialCode(trimmed) || isPrsAtlas30Code(trimmed)) return trimmed.toUpperCase();
  return trimmed;
}

export function isUnlimitedInstitutionalExpiry(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() >= UNLIMITED_INSTITUTIONAL_EXPIRES_AT_MS;
}

export function accessDurationDaysForCodeType(codeType: InstitutionalCodeType): number {
  return codeType === "trial" ? TRIAL_CODE_DURATION_DAYS : INSTITUTIONAL_CODE_DURATION_DAYS;
}

export function addCalendarDays(from: Date, days: number): Date {
  const next = new Date(from);
  next.setDate(next.getDate() + days);
  return next;
}

export function addCalendarMonths(from: Date, months: number): Date {
  const next = new Date(from);
  next.setMonth(next.getMonth() + months);
  return next;
}

/** 90 days after the code is created. Redemption stops; already-granted access is unaffected. */
export function redeemExpiresAtFromCreatedAt(createdAt: Date, now: Date = new Date()): Date {
  return addCalendarDays(createdAt ?? now, CODE_REDEEM_WINDOW_DAYS);
}

/**
 * Whether this code may still be redeemed.
 * Deactivated codes are handled separately. Null redeemExpiresAt means no time limit (legacy).
 */
export function isCodeRedeemWindowOpen(
  redeemExpiresAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!redeemExpiresAt) return true;
  return redeemExpiresAt.getTime() > now.getTime();
}

export function institutionalAccessExpiresAtForRedemption(
  plainCode: string,
  codeType: InstitutionalCodeType = "institutional",
): Date {
  if (isUnlimitedInstitutionalCode(plainCode)) {
    return new Date(UNLIMITED_INSTITUTIONAL_EXPIRES_AT_ISO);
  }
  if (isPrsAtlas30Code(plainCode)) {
    return addCalendarMonths(new Date(), 1);
  }
  return addCalendarDays(new Date(), accessDurationDaysForCodeType(codeType));
}

export function institutionalDaysRemaining(
  expiresAt: Date | null,
  now: Date = new Date()
): number | null {
  if (!expiresAt) return null;
  if (isUnlimitedInstitutionalExpiry(expiresAt)) return null;
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}
