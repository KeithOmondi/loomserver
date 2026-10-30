// src/utils/sendSms.ts
//
// SMS via Africa's Talking. Credentials are optional: when AT_API_KEY / AT_USERNAME are not set
// (development, sandbox) the message is logged instead of sent, so flows still work end to end.
import { env } from '../config/env';

const AT_URL = 'https://api.africastalking.com/version1/messaging';

/** Normalises Kenyan numbers to +254XXXXXXXXX. Returns null if it doesn't look like a phone number. */
export const normalizePhone = (raw: string): string | null => {
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+254\d{9}$/.test(digits)) return digits;
  if (/^254\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0\d{9}$/.test(digits)) return `+254${digits.slice(1)}`;
  return null;
};

export const sendSms = async (to: string, message: string): Promise<void> => {
  const phone = normalizePhone(to);
  if (!phone) throw new Error(`Invalid phone number for SMS: ${to}`);

  if (!env.AT_API_KEY || !env.AT_USERNAME) {
    console.log(`[sms:dev] to=${phone.slice(0, 7)}*** message="${message.slice(0, 60)}"`);
    return;
  }

  const body = new URLSearchParams({ username: env.AT_USERNAME, to: phone, message });
  if (env.AT_SENDER_ID) body.set('from', env.AT_SENDER_ID);

  const res = await fetch(AT_URL, {
    method: 'POST',
    headers: { apiKey: env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    console.error('[sms] provider error', res.status, await res.text().catch(() => ''));
    throw new Error('SMS provider rejected the message');
  }
};
