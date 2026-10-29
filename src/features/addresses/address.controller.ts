// src/features/addresses/address.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import {
  getUserAddresses,
  getAddressById,
  createAddress,
  updateAddress,
  setDefaultAddress,
  deleteAddress,
} from './address.service';
import type {
  CreateAddressInput,
  UpdateAddressInput,
} from './address.types';

// ============================================
// HELPERS
// ============================================

const requireUser = (req: Request): NonNullable<Request['user']> => {
  if (!req.user) throw new AppError(401, 'Authentication required.');
  return req.user;
};

const extractString = (param: string | string[] | undefined): string => {
  if (!param) throw new AppError(400, 'Parameter is required');
  return Array.isArray(param) ? param[0] : param;
};

// ============================================
// LIST — GET /api/v1/addresses
// ============================================

export const getAddressesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    const addresses = await getUserAddresses(user.id);

    res.status(200).json({
      success: true,
      data: addresses,
    });
  },
);

// ============================================
// GET ONE — GET /api/v1/addresses/:addressId
// ============================================

export const getAddressHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    const addressId = extractString(req.params.addressId);

    const address = await getAddressById(addressId, user.id);
    if (!address) {
      throw new AppError(404, 'Address not found.');
    }

    res.status(200).json({
      success: true,
      data: address,
    });
  },
);

// ============================================
// CREATE — POST /api/v1/addresses
// ============================================

export const createAddressHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    const input = req.body as CreateAddressInput;

    const address = await createAddress(user.id, input);

    res.status(201).json({
      success: true,
      message: 'Address saved.',
      data: address,
    });
  },
);

// ============================================
// UPDATE — PATCH /api/v1/addresses/:addressId
// ============================================

export const updateAddressHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    const addressId = extractString(req.params.addressId);

    const input = req.body as UpdateAddressInput;

    const address = await updateAddress(addressId, user.id, input);

    res.status(200).json({
      success: true,
      message: 'Address updated.',
      data: address,
    });
  },
);

// ============================================
// SET DEFAULT — PATCH /api/v1/addresses/:addressId/default
// ============================================

export const setDefaultAddressHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    const addressId = extractString(req.params.addressId);

    const address = await setDefaultAddress(addressId, user.id);

    res.status(200).json({
      success: true,
      message: 'Default address updated.',
      data: address,
    });
  },
);

// ============================================
// DELETE — DELETE /api/v1/addresses/:addressId
// ============================================

export const deleteAddressHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    const addressId = extractString(req.params.addressId);

    await deleteAddress(addressId, user.id);

    res.status(200).json({
      success: true,
      message: 'Address deleted.',
    });
  },
);