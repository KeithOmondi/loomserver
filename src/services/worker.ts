// src/services/worker.ts
//
// Background worker, run inside the API process. Every tick (default 30s) it: sends queued
// emails/SMS, auto-releases escrow, escalates overdue disputes, expires unpaid orders, drafts
// scheduled payout batches and flags refund abuse. A Postgres advisory lock makes sure only one
// instance runs a tick at a time, so scaling the API to several instances is safe.
import { pool } from '../config/db';
import { escalateOverdueDisputes } from '../features/aftersales/aftersales.service';
import { expireUnpaidOrders } from '../features/orders/order-lifecycle.service';
import { generateScheduledBatches } from '../features/payouts/payouts.service';
import { reconcileStalePayments } from '../features/mpesaservice/mpesa.service';
import { releaseDueEscrows } from './escrow.service';
import { flagRefundAbuse } from './fraud.service';
import { runDueJobs } from './jobs.service';
import './notification.service'; // registers the email / sms job handlers

const LOCK_KEY = 727_001;
let lastHourly = 0;

const step = async (name: string, fn: () => Promise<unknown>) => {
  try {
    const out = await fn();
    if (typeof out === 'number' && out > 0) console.log(`[worker] ${name}: ${out}`);
  } catch (err) {
    console.error(`[worker] ${name} failed:`, (err as Error).message);
  }
};

export const tick = async (): Promise<boolean> => {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!lock.rows[0].ok) return false; // another instance is running this tick

    await step('M-Pesa reconcile', reconcileStalePayments);
    await step('jobs', () => runDueJobs());
    await step('escrow auto-release', releaseDueEscrows);
    await step('dispute escalation', escalateOverdueDisputes);
    await step('order expiry', expireUnpaidOrders);

    if (Date.now() - lastHourly > 3_600_000) {
      lastHourly = Date.now();
      await step('scheduled payout batches', () => generateScheduledBatches());
      await step('refund-abuse check', flagRefundAbuse);
    }
    return true;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
};

export const startWorker = (intervalMs = 30_000): (() => void) => {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap ticks in one process
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error('[worker] tick failed:', (err as Error).message);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  console.log(`🛠️  Background worker started (every ${intervalMs / 1000}s)`);
  return () => clearInterval(timer);
};
