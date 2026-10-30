// src/services/notification.service.ts
//
// One call fans a business event out to the in-app inbox, email and SMS. Email and SMS are
// queued (and retried) rather than sent inline, so a provider outage never blocks an order.
import type { Pool, PoolClient } from 'pg';
import { pool } from '../config/db';
import { env } from '../config/env';
import { enqueue, registerHandler } from './jobs.service';
import { sendMail } from '../utils/sendMail';
import { sendSms } from '../utils/sendSms';

type Queryable = Pool | PoolClient;

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  /** link shown as a button in the email, e.g. `/orders/123` */
  link?: string;
  email?: boolean;
  sms?: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const renderEmail = (title: string, body: string, link?: string): string => {
  const url = link ? `${env.webUrl}${link}` : null;
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#1c1917">
    <h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
    <p style="line-height:1.6;white-space:pre-line">${escapeHtml(body)}</p>
    ${url ? `<p style="margin:24px 0"><a href="${url}" style="background:#b85a38;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">View details</a></p>` : ''}
    <p style="color:#78716c;font-size:12px">${escapeHtml(env.APP_NAME)}</p>
  </div>`;
};

/** Never throws — a notification failure must not roll back the business action. */
export const notify = async (input: NotifyInput, q: Queryable = pool): Promise<void> => {
  try {
    await q.query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [input.userId, input.type, input.title, input.body ?? null, JSON.stringify({ ...input.data, link: input.link })],
    );
    if (input.email !== false) {
      await enqueue('email', { userId: input.userId, title: input.title, body: input.body ?? '', link: input.link }, {}, q);
    }
    if (input.sms) {
      await enqueue('sms', { userId: input.userId, message: input.sms }, {}, q);
    }
  } catch (err) {
    console.error('[notify] failed', input.type, (err as Error).message);
  }
};

/** Notify every user holding one of the given roles (e.g. finance when a payout needs approval). */
export const notifyRoles = async (roles: string[], input: Omit<NotifyInput, 'userId'>): Promise<void> => {
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE role = ANY($1::text[]) AND is_active = true`,
    [roles],
  );
  await Promise.all(res.rows.map((u) => notify({ ...input, userId: u.id })));
};

registerHandler('email', async (p: { userId: string; title: string; body: string; link?: string }) => {
  const u = await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [p.userId]);
  if (!u.rows[0]) return;
  await sendMail({ to: u.rows[0].email, subject: p.title, html: renderEmail(p.title, p.body, p.link), text: p.body });
});

registerHandler('sms', async (p: { userId: string; message: string }) => {
  const u = await pool.query<{ phone: string | null }>('SELECT phone FROM users WHERE id = $1', [p.userId]);
  if (!u.rows[0]?.phone) return; // nothing to send to — not an error worth retrying
  await sendSms(u.rows[0].phone, p.message);
});
