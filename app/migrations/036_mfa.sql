-- =====================================================================
-- NFR — Multi-Factor Authentication (TOTP) secret column.
-- sec.app_user already carries mfa_enabled (db/01); add the Base32 secret the
-- TOTP verifier checks against. Enrollment (POST /api/auth/mfa/setup -> enable)
-- writes it; login requires a valid code whenever mfa_enabled is true.
-- Idempotent.
-- =====================================================================
ALTER TABLE sec.app_user
  ADD COLUMN IF NOT EXISTS mfa_secret VARCHAR(64);

-- End migration 036_mfa.
