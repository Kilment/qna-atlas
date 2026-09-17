-- One-time promo codes (e.g. PRSATLAS30): null = unlimited redemptions.
ALTER TABLE "institutional_codes"
  ADD COLUMN IF NOT EXISTS "max_redemptions" integer;
