// src/utils/generateOTP.ts
import crypto from 'crypto';

/**
 * generateOTP — cryptographically random numeric code, zero-padded to
 * `length` digits. Uses crypto.randomInt (not Math.random) since this
 * is a security-sensitive value — Math.random is not suitable for
 * anything auth-adjacent.
 *
 * Default length 6 matches the existing seller-onboarding OTP flow,
 * for consistency across the app.
 */
export const generateOTP = (length = 6): string => {
  const max = 10 ** length;
  const otp = crypto.randomInt(0, max);
  return otp.toString().padStart(length, '0');
};