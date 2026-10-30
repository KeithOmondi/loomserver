// src/features/aftersales/aftersales.routes.ts
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { mediaUrl, uploadToCloudinary } from '../../config/cloudinary';
import { protect, requireRole, requireStaff } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import * as svc from './aftersales.service';

const uuid = z.string().uuid();
const evidenceItem = z.object({ url: z.string().url(), public_id: z.string().optional(), mime: z.string().optional() });

// ---------------------------------------------------------------------------
// Evidence / photo uploads (returns, disputes)
// ---------------------------------------------------------------------------
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) =>
    ALLOWED.includes(file.mimetype) ? cb(null, true) : cb(new AppError(400, 'Only JPG, PNG, WEBP or PDF files up to 8MB are allowed.') as any),
}).array('files', 6);

export const uploadsRouter = Router();
uploadsRouter.post(
  '/evidence',
  protect,
  (req, res, next) => upload(req, res, (err) => (err ? next(err instanceof multer.MulterError ? new AppError(400, err.message) : err) : next())),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) throw new AppError(400, 'Attach at least one file.');
    const out = [];
    for (const f of files) {
      const asset = await uploadToCloudinary(f, `evidence/${req.user!.id}`);
      out.push({
        url: mediaUrl({ publicId: asset.publicId, resourceType: asset.resourceType, format: asset.format }),
        public_id: asset.publicId,
        mime: f.mimetype,
      });
    }
    res.status(201).json({ success: true, data: out });
  }),
);

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------
export const returnsRouter = Router();

returnsRouter.post(
  '/',
  protect,
  validate(
    z.object({
      body: z.object({
        order_id: uuid,
        order_item_id: uuid,
        quantity: z.number().int().positive().optional(),
        reason: z.string().min(3).max(200),
        description: z.string().max(2000).optional(),
        photos: z.array(z.string().url()).max(6).optional(),
        preferred_resolution: z.enum(['refund', 'wallet']).optional(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.status(201).json({ success: true, data: await svc.createReturn(req.user!.id, req.body) });
  }),
);

returnsRouter.get('/mine', protect, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.listReturns({ userId: req.user!.id }) });
}));

returnsRouter.get('/store', protect, requireRole('seller'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.listReturns({ storeUserId: req.user!.id, status: req.query.status as string | undefined }) });
}));

returnsRouter.get('/', protect, requireStaff('support', 'finance'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.listReturns({ status: req.query.status as string | undefined }) });
}));

const idParam = z.object({ params: z.object({ id: uuid }) });

returnsRouter.post(
  '/:id/decision',
  protect,
  requireRole('seller'),
  validate(z.object({ params: idParam.shape.params, body: z.object({ accept: z.boolean(), response: z.string().max(1000).optional() }) })),
  asyncHandler(async (req, res) => {
    await svc.decideReturn(String(req.params.id), req.user!, req.body.accept, req.body.response);
    res.json({ success: true });
  }),
);

returnsRouter.post(
  '/:id/tracking',
  protect,
  validate(z.object({ params: idParam.shape.params, body: z.object({ tracking: z.string().min(3).max(80) }) })),
  asyncHandler(async (req, res) => {
    await svc.addReturnTracking(String(req.params.id), req.user!.id, req.body.tracking);
    res.json({ success: true });
  }),
);

returnsRouter.post(
  '/:id/received',
  protect,
  requireRole('seller'),
  validate(z.object({ params: idParam.shape.params, body: z.object({ refund_amount: z.number().positive().optional() }) })),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await svc.markReturnReceived(String(req.params.id), req.user!, req.body.refund_amount) });
  }),
);

returnsRouter.post('/:id/escalate', protect, validate(idParam), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.escalateReturn(String(req.params.id), req.user!.id) });
}));

// ---------------------------------------------------------------------------
// Refunds (finance / admin)
// ---------------------------------------------------------------------------
export const refundsRouter = Router();
refundsRouter.use(protect, requireStaff('finance', 'support'));

refundsRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.listRefunds(req.query.status as string | undefined) });
}));

refundsRouter.post(
  '/:id/approve',
  requireStaff('finance'),
  validate(z.object({ params: idParam.shape.params, body: z.object({ method: z.enum(['original', 'wallet']).optional(), reference: z.string().max(60).optional() }) })),
  asyncHandler(async (req, res) => {
    await svc.approveRefund(String(req.params.id), req.user!, req.body);
    res.json({ success: true });
  }),
);

refundsRouter.post(
  '/:id/reject',
  requireStaff('finance'),
  validate(z.object({ params: idParam.shape.params, body: z.object({ reason: z.string().min(3).max(300) }) })),
  asyncHandler(async (req, res) => {
    await svc.rejectRefund(String(req.params.id), req.user!, req.body.reason);
    res.json({ success: true });
  }),
);

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------
export const disputesRouter = Router();
disputesRouter.use(protect);

disputesRouter.post(
  '/',
  validate(
    z.object({
      body: z.object({
        order_id: uuid,
        reason: z.string().min(3).max(200),
        description: z.string().max(3000).optional(),
        evidence: z.array(evidenceItem).max(6).optional(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.status(201).json({ success: true, data: await svc.openDispute(req.user!, req.body) });
  }),
);

disputesRouter.get('/', asyncHandler(async (req, res) => {
  const staff = ['admin', 'super_admin', 'support', 'finance'].includes(req.user!.role);
  res.json({ success: true, data: await svc.listDisputes({ userId: req.user!.id, staff, status: req.query.status as string | undefined }) });
}));

disputesRouter.get('/:id', validate(idParam), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.getDispute(String(req.params.id), req.user!) });
}));

disputesRouter.post(
  '/:id/messages',
  validate(z.object({ params: idParam.shape.params, body: z.object({ body: z.string().min(1).max(3000), evidence: z.array(evidenceItem).max(6).optional() }) })),
  asyncHandler(async (req, res) => {
    res.status(201).json({ success: true, data: await svc.addDisputeMessage(String(req.params.id), req.user!, req.body.body, req.body.evidence) });
  }),
);

disputesRouter.post('/:id/escalate', validate(idParam), asyncHandler(async (req, res) => {
  await svc.escalateDispute(String(req.params.id), req.user!);
  res.json({ success: true });
}));

disputesRouter.post(
  '/:id/resolve',
  requireStaff('support'),
  validate(
    z.object({
      params: idParam.shape.params,
      body: z.object({
        resolution: z.enum(['full_refund', 'partial_refund', 'release_to_vendor', 'replacement']),
        amount: z.number().positive().optional(),
        notes: z.string().min(3).max(2000),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    await svc.resolveDispute(String(req.params.id), req.user!, req.body);
    res.json({ success: true });
  }),
);
