// src/utils/sendMail.ts
import { env } from '../config/env';
import { AppError } from './response';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

interface SendMailParams {
  to:      string;
  subject: string;
  html:    string;
  // Plain-text fallback for clients that don't render HTML. Optional —
  // Brevo will derive a basic one from `html` if omitted, but an
  // explicit version is more reliable for deliverability/spam scoring.
  text?:   string;
}

/**
 * sendMail — thin wrapper around Brevo's transactional email API.
 * Throws AppError(502, ...) on failure rather than swallowing errors,
 * so callers can decide how to handle a delivery failure (e.g. the
 * forgot-password flow should NOT reveal to the client whether the
 * send succeeded — see the caller for that reasoning — but internal
 * logs/monitoring still need the real failure surfaced).
 */
export const sendMail = async ({ to, subject, html, text }: SendMailParams): Promise<void> => {
  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      'api-key':      env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: {
        name:  env.BREVO_SENDER_NAME,
        email: env.BREVO_SENDER_EMAIL,
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      ...(text ? { textContent: text } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Never leak provider error details (could include API key hints,
    // internal Brevo error codes) to the client — log server-side only.
    console.error('Brevo send failed:', response.status, body);
    throw new AppError(502, 'Failed to send email. Please try again later.');
  }
};