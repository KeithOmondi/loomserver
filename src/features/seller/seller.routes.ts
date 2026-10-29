// src/routes/seller.routes.ts

import { Router } from "express";

// ─── Validators ─────────────────────────────────────────────
import {
  createSellerProfileSchema,
  updateSellerProfileSchema,
  getSellersQuerySchema,
  verifySellerSchema,
  suspendSellerSchema,
  reinstateSellerSchema,
  updateSellerTierSchema,
  sellerMetricsSchema,
  sellerStatusCheckSchema,
  uploadKycDocumentSchema,
  deleteKycDocumentSchema,
  verifyDocumentSchema,
} from "./seller.validator";

// ─── Controllers ────────────────────────────────────────────
import {
  // Seller (self)
  getMe,
  setupSellerProfile,
  getMySellerProfile,
  updateMySellerProfile,
  getSellerProfileStatus,
  checkStoreEligibility,
  getSetupProgress,
  getSellerMetricsController,

  // KYC documents (seller)
  uploadMyKycDocument,
  deleteMyKycDocument,

  // KYC documents (moderator / admin)
  verifySellerDocument,

  // Admin
  getAllSellers,
  verifySeller,
  suspendSellerProfile,
  reinstateSellerProfile,
  getSellerByIdAdmin,
  getSellerStatsAdmin,
  updateSellerTierAdmin,

  // Public
  getSellerProfile,
} from "./seller.controller";

// ─── Middleware ─────────────────────────────────────────────
import {
  protect,
  requireAdmin,
  requireModerator,
} from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { uploadKycDocument } from "../../middlewares/upload";

const router = Router();

// ============================================================
// ROUTE ORDER (Express matches top-down)
//
//   1. Static /me, /profile, /setup, /metrics, /store-eligibility
//   2. Nested /admin/*
//   3. Public dynamic /:sellerId  ← LAST
//
// /:sellerId MUST be last, or it shadows everything above.
// ============================================================

// ────────────────────────────────────────────────────────────
// SELLER — SELF
// ────────────────────────────────────────────────────────────

// Current user + seller data
router.get("/me", protect, getMe);

// Onboarding: create seller profile
router.post(
  "/setup",
  protect,
  validate(createSellerProfileSchema),
  setupSellerProfile
);

// My seller profile
router.get("/profile", protect, getMySellerProfile);
router.put(
  "/profile",
  protect,
  validate(updateSellerProfileSchema),
  updateMySellerProfile
);

// Profile status (gatekeeper info)
router.get("/profile/status", protect, getSellerProfileStatus);

// Onboarding progress
router.get("/profile/progress", protect, getSetupProgress);

// Store eligibility
router.get("/store-eligibility", protect, checkStoreEligibility);

// Metrics
router.get(
  "/metrics",
  protect,
  validate(sellerMetricsSchema),
  getSellerMetricsController
);

// ────────────────────────────────────────────────────────────
// SELLER — KYC DOCUMENTS
// ────────────────────────────────────────────────────────────

// Upload one KYC document
//   Content-Type: multipart/form-data
//   fields: file (required), document_type (required), filename (optional)
router.post(
  "/me/documents",
  protect,
  uploadKycDocument,
  validate(uploadKycDocumentSchema),
  uploadMyKycDocument
);

// Delete a KYC document by type
router.delete(
  "/me/documents/:documentType",
  protect,
  validate(deleteKycDocumentSchema),
  deleteMyKycDocument
);

// ────────────────────────────────────────────────────────────
// ADMIN / MODERATOR
// ────────────────────────────────────────────────────────────

// Listing + stats
router.get(
  "/admin/sellers",
  protect,
  requireAdmin,
  validate(getSellersQuerySchema),
  getAllSellers
);

router.get("/admin/stats", protect, requireAdmin, getSellerStatsAdmin);

// Detail (admin view)
router.get(
  "/admin/sellers/:sellerId",
  protect,
  requireAdmin,
  validate(sellerStatusCheckSchema),
  getSellerByIdAdmin
);

// Verify / reject seller (whole-seller decision)
router.put(
  "/admin/sellers/:sellerId/verify",
  protect,
  requireAdmin,
  validate(verifySellerSchema),
  verifySeller
);

// Suspend / reinstate
router.post(
  "/admin/sellers/:sellerId/suspend",
  protect,
  requireAdmin,
  validate(suspendSellerSchema),
  suspendSellerProfile
);

router.post(
  "/admin/sellers/:sellerId/reinstate",
  protect,
  requireAdmin,
  validate(reinstateSellerSchema),
  reinstateSellerProfile
);

// Tier management
router.put(
  "/admin/sellers/:sellerId/tier",
  protect,
  requireAdmin,
  validate(updateSellerTierSchema),
  updateSellerTierAdmin
);

// Per-document verification (moderator or admin)
router.patch(
  "/admin/sellers/:sellerId/documents/:documentType/verify",
  protect,
  requireModerator,
  validate(verifyDocumentSchema),
  verifySellerDocument
);

// ────────────────────────────────────────────────────────────
// PUBLIC — MUST BE LAST
// ────────────────────────────────────────────────────────────

router.get("/:sellerId", getSellerProfile);

export default router;