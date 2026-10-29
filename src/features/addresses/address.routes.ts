// src/features/addresses/address.routes.ts

import { Router } from 'express';
import { protect } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createAddressSchema,
  updateAddressSchema,
  addressIdParamSchema,
  setDefaultAddressSchema,
} from './address.validator';
import {
  getAddressesHandler,
  getAddressHandler,
  createAddressHandler,
  updateAddressHandler,
  setDefaultAddressHandler,
  deleteAddressHandler,
} from './address.controller';

const router = Router();

// ============================================================
// ADDRESS ROUTES
//
// Every route is user-scoped — protect is applied to all of them,
// and the service layer enforces user_id ownership on every query.
// ============================================================

/**
 * GET /api/v1/addresses
 * List the current user's saved addresses.
 */
router.get('/', protect, getAddressesHandler);

/**
 * POST /api/v1/addresses
 * Save a new address.
 */
router.post(
  '/',
  protect,
  validate(createAddressSchema),
  createAddressHandler,
);

/**
 * PATCH /api/v1/addresses/:addressId/default
 *
 * Registered BEFORE /:addressId so 'default' isn't captured as an id —
 * though in practice the two paths differ in segment count, so the
 * ordering here is for clarity, not correctness.
 */
router.patch(
  '/:addressId/default',
  protect,
  validate(setDefaultAddressSchema),
  setDefaultAddressHandler,
);

/**
 * GET /api/v1/addresses/:addressId
 */
router.get(
  '/:addressId',
  protect,
  validate(addressIdParamSchema),
  getAddressHandler,
);

/**
 * PATCH /api/v1/addresses/:addressId
 */
router.patch(
  '/:addressId',
  protect,
  validate(updateAddressSchema),
  updateAddressHandler,
);

/**
 * DELETE /api/v1/addresses/:addressId
 */
router.delete(
  '/:addressId',
  protect,
  validate(addressIdParamSchema),
  deleteAddressHandler,
);

export default router;