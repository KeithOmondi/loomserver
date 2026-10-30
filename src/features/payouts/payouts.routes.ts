// src/features/payouts/payouts.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import { protect, requireRole, requireStaff } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import * as svc from './payouts.service';

const uuid = z.string().uuid();
const idParam = z.object({ params: z.object({ id: uuid }) });
const router = Router();
router.use(protect);

// ----------------------------- vendor -----------------------------
router.get('/summary', requireRole('seller'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.getPayoutSummary(req.user!.id) });
}));

router.get('/mine', requireRole('seller'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.listStorePayouts(req.user!.id) });
}));

router.put(
  '/settings',
  requireRole('seller'),
  validate(
    z.object({
      body: z.object({
        payout_method: z.enum(['mpesa', 'bank']),
        mpesa_phone: z.string().max(20).optional(),
        bank_name: z.string().max(100).optional(),
        bank_account_name: z.string().max(150).optional(),
        bank_account_number: z.string().max(40).optional(),
        payout_schedule: z.enum(['weekly', 'monthly']).optional(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    await svc.updatePayoutSettings(req.user!.id, req.body);
    res.json({ success: true });
  }),
);

router.get('/statement.csv', requireRole('seller'), asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 86_400_000);
  const csv = await svc.buildStatementCsv(req.user!.id, from, new Date(to.getTime() + 86_400_000));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="loom-statement-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// ----------------------------- finance -----------------------------
const finance = requireStaff('finance');

router.get('/admin/batches', finance, asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await svc.listBatches() });
}));

router.get('/admin/payouts', finance, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.listAllPayouts({ batchId: req.query.batch_id as string | undefined, status: req.query.status as string | undefined }) });
}));

router.post(
  '/admin/batches/generate',
  finance,
  validate(z.object({ body: z.object({ schedule: z.enum(['weekly', 'monthly', 'all']).default('all') }) })),
  asyncHandler(async (req, res) => {
    res.status(201).json({ success: true, data: await svc.generateBatch(req.user!, req.body.schedule) });
  }),
);

router.post('/admin/batches/:id/approve', finance, validate(idParam), asyncHandler(async (req, res) => {
  await svc.approveBatch(String(req.params.id), req.user!);
  res.json({ success: true });
}));

router.post('/admin/batches/:id/cancel', finance, validate(idParam), asyncHandler(async (req, res) => {
  await svc.cancelBatch(String(req.params.id), req.user!);
  res.json({ success: true });
}));

router.post(
  '/admin/payouts/:id/paid',
  finance,
  validate(z.object({ params: idParam.shape.params, body: z.object({ reference: z.string().min(3).max(60) }) })),
  asyncHandler(async (req, res) => {
    await svc.markPayoutPaid(String(req.params.id), req.user!, req.body.reference);
    res.json({ success: true });
  }),
);

router.post(
  '/admin/payouts/:id/failed',
  finance,
  validate(z.object({ params: idParam.shape.params, body: z.object({ reason: z.string().min(3).max(300) }) })),
  asyncHandler(async (req, res) => {
    await svc.markPayoutFailed(String(req.params.id), req.user!, req.body.reason);
    res.json({ success: true });
  }),
);

router.post('/admin/payouts/:id/retry', finance, validate(idParam), asyncHandler(async (req, res) => {
  await svc.retryPayout(String(req.params.id), req.user!);
  res.json({ success: true });
}));

router.get('/admin/holds', finance, asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await svc.listHolds() });
}));

router.post(
  '/admin/holds',
  finance,
  validate(z.object({ body: z.object({ store_id: uuid, reason: z.string().min(3).max(300) }) })),
  asyncHandler(async (req, res) => {
    await svc.placeHold(req.body.store_id, req.user!, req.body.reason);
    res.status(201).json({ success: true });
  }),
);

router.delete('/admin/holds/:id', finance, validate(idParam), asyncHandler(async (req, res) => {
  await svc.releaseHold(String(req.params.id), req.user!); // :id is the store id
  res.json({ success: true });
}));

export default router;
