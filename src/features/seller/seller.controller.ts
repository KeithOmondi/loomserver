// src/sellers/seller.controller.ts

import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/response";
import { pool } from "../../config/db";
import {
  createSellerProfile,
  getSellerByUserId,
  getSellerById,
  updateSellerProfile,
  getSellerSetupProgress,
  getUserWithSellerData,
  updateSellerVerification,
  suspendSeller,
  reinstateSeller,
  getSellers,
  checkSellerStatus,
  getSellerMetrics,
  updateSellerTier,
  sellerExists,
  uploadKycDocument,
  deleteKycDocument,
  verifyKycDocument,
  verifySellerBulk,
} from "./seller.service";
import {
  CreateSellerInput,
  UpdateSellerInput,
  SellerStatus,
  SellerSetupStep,
  KycDocumentType,
  DocumentVerificationStatus,
} from "./seller.types";

// ============================================
// HELPERS
// ============================================

const extractId = (param: string | string[] | undefined): string => {
  if (!param) throw new AppError(400, "ID is required");
  return Array.isArray(param) ? param[0] : param;
};

const requireAuth = (req: Request): NonNullable<Request["user"]> => {
  if (!req.user) throw new AppError(401, "Authentication required.");
  return req.user;
};

const requireAdmin = (req: Request): NonNullable<Request["user"]> => {
  const user = requireAuth(req);
  if (user.role !== "admin" && user.role !== "super_admin") {
    throw new AppError(403, "Admin access required.");
  }
  return user;
};


const requireModeratorOrAdmin = (req: Request): NonNullable<Request["user"]> => {
  const user = requireAuth(req);
  if (!["moderator", "admin", "super_admin"].includes(user.role)) {
    throw new AppError(403, "Moderator or admin access required.");
  }
  return user;
};




const buildActions = (progress: {
  missingFields: string[];
  requiredDocuments: KycDocumentType[];
  uploadedDocuments: KycDocumentType[];
  currentStep: SellerSetupStep;
  isComplete: boolean;
}) => {
  const actions: Array<{
    label: string;
    route: string;
    priority: "high" | "medium" | "low";
  }> = [];

  if (progress.missingFields.length > 0) {
    actions.push({
      label: "Complete Business Information",
      route: "/seller/setup/business",
      priority: "high",
    });
  }

  if (progress.requiredDocuments.length > progress.uploadedDocuments.length) {
    actions.push({
      label: "Upload Verification Documents",
      route: "/seller/setup/kyc",
      priority: "high",
    });
  }

  if (progress.currentStep === SellerSetupStep.PAYMENT_SETUP) {
    actions.push({
      label: "Configure Payout Settings",
      route: "/seller/setup/payout",
      priority: "medium",
    });
  }

  if (progress.isComplete) {
    actions.push({
      label: "Create Your First Store",
      route: "/seller/stores/create",
      priority: "high",
    });
  }

  return actions;
};

// ============================================
// SELLER ONBOARDING
// ============================================

export const setupSellerProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = requireAuth(req);

  if (user.role !== "seller") {
    throw new AppError(403, "Only sellers can create seller profiles.");
  }

  const input = req.body as CreateSellerInput;

  const seller = await createSellerProfile(user.id, input);
  const progress = await getSellerSetupProgress(seller.id);

  let nextStep: "upload_kyc" | "configure_payout" | "create_store" | "complete" =
    "upload_kyc";
  if (progress.isComplete) nextStep = "complete";
  else if (progress.currentStep === SellerSetupStep.PAYMENT_SETUP)
    nextStep = "configure_payout";
  else if (progress.currentStep === SellerSetupStep.KYC_DOCUMENTS)
    nextStep = "upload_kyc";
  else if (progress.currentStep === SellerSetupStep.COMPLETE) nextStep = "create_store";

  res.status(201).json({
    success: true,
    message: "Seller profile created successfully.",
    data: {
      seller,
      progress,
      nextStep,
      actions: buildActions(progress),
    },
  });
});

// ============================================
// SELLER STATUS / PROGRESS
// ============================================

export const getSellerProfileStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireAuth(req);

    const seller = await getSellerByUserId(user.id);

    if (!seller) {
      return res.status(200).json({
        success: true,
        data: {
          exists: false,
          is_active: false,
          can_create_stores: false,
          can_update_stores: false,
          onboarding_complete: false,
          onboarding_step: SellerSetupStep.BASIC_INFO,
          missing_fields: [],
          missing_documents: [],
          message: "Seller profile not set up yet.",
          actions_required: ["create_seller_profile"],
        },
      });
    }

    const statusCheck = await checkSellerStatus(seller.id);
    const progress = await getSellerSetupProgress(seller.id);

    res.status(200).json({
      success: true,
      data: {
        exists: true,
        seller,
        ...statusCheck,
        ...progress,
      },
    });
  }
);

export const getMySellerProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = requireAuth(req);

  const seller = await getSellerByUserId(user.id);
  if (!seller) throw new AppError(404, "Seller profile not found.");

  const [statusCheck, progress] = await Promise.all([
    checkSellerStatus(seller.id),
    getSellerSetupProgress(seller.id),
  ]);

  res.status(200).json({
    success: true,
    data: { seller, status: statusCheck, progress },
  });
});

export const getSetupProgress = asyncHandler(async (req: Request, res: Response) => {
  const user = requireAuth(req);

  const seller = await getSellerByUserId(user.id);
  if (!seller) throw new AppError(404, "Seller profile not found.");

  const [progress, statusCheck] = await Promise.all([
    getSellerSetupProgress(seller.id),
    checkSellerStatus(seller.id),
  ]);

  res.status(200).json({
    success: true,
    data: { progress, status: statusCheck },
  });
});

// ============================================
// UPDATE SELLER PROFILE
// ============================================

export const updateMySellerProfile = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireAuth(req);

    const exists = await sellerExists(user.id);
    if (!exists) {
      throw new AppError(404, "Seller profile not found. Please create one first.");
    }

    const input = req.body as UpdateSellerInput;
    const { seller, kycRequired } = await updateSellerProfile(user.id, input);
    const statusCheck = await checkSellerStatus(seller.id);

    res.status(200).json({
      success: true,
      message: kycRequired
        ? "Seller profile updated. KYC re-verification is required."
        : "Seller profile updated successfully.",
      data: { seller, kycRequired, status: statusCheck },
    });
  }
);

// ============================================
// GET ME (User + Seller)
// ============================================

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const user = requireAuth(req);

  const userWithSeller = await getUserWithSellerData(user.id);
  if (!userWithSeller) throw new AppError(404, "User not found.");

  const statusCheck = userWithSeller.seller
    ? await checkSellerStatus(userWithSeller.seller.id)
    : null;

  res.status(200).json({
    success: true,
    data: { ...userWithSeller, status: statusCheck },
  });
});

// ============================================
// SELLER METRICS
// ============================================

export const getSellerMetricsController = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireAuth(req);

    const seller = await getSellerByUserId(user.id);
    if (!seller) throw new AppError(404, "Seller profile not found.");

    const period =
      (req.query.period as "today" | "week" | "month" | "year" | "all") || "month";

    const metrics = await getSellerMetrics(seller.id, period);

    res.status(200).json({ success: true, data: metrics });
  }
);

// ============================================
// PUBLIC SELLER PROFILE
// ============================================

export const getSellerProfile = asyncHandler(async (req: Request, res: Response) => {
  const sellerId = extractId(req.params.sellerId);

  const seller = await getSellerById(sellerId);
  if (!seller) throw new AppError(404, "Seller not found.");

  const publicSeller = {
    id: seller.id,
    legal_business_name: seller.legal_business_name,
    trading_name: seller.trading_name,
    business_type: seller.business_type,
    country: seller.country,
    state: seller.state,
    city: seller.city,
    business_address: seller.business_address,
    rating: seller.rating,
    total_reviews: seller.total_reviews,
    total_orders: seller.total_orders,
    total_products: seller.total_products,
    total_stores: seller.total_stores,
    fulfillment_rate: seller.fulfillment_rate,
    response_rate: seller.response_rate,
    response_time_hours: seller.response_time_hours,
    status:
      seller.status === SellerStatus.VERIFIED ? "verified" : "unverified",
    created_at: seller.created_at,
  };

  res.status(200).json({ success: true, data: publicSeller });
});

// ============================================
// STORE ELIGIBILITY
// ============================================

export const checkStoreEligibility = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireAuth(req);

    const seller = await getSellerByUserId(user.id);
    if (!seller) throw new AppError(404, "Seller profile not found.");

    const status = await checkSellerStatus(seller.id);

    res.status(200).json({
      success: true,
      data: {
        can_create_stores: status.can_create_stores,
        can_update_stores: status.can_update_stores,
        current_store_count: status.current_store_count,
        max_stores_allowed: status.max_stores_allowed,
        block_reason: status.block_reason,
        actions_required: status.actions_required,
        missing_fields: status.missing_fields,
        missing_documents: status.missing_documents,
      },
    });
  }
);

// ============================================
// KYC DOCUMENT ENDPOINTS
// ============================================

/**
 * POST /sellers/me/documents
 * Multipart upload: field "file" + body field "document_type"
 * Uses multer middleware upstream to attach req.file.
 */
export const uploadMyKycDocument = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireAuth(req);

    const seller = await getSellerByUserId(user.id);
    if (!seller) throw new AppError(404, "Seller profile not found.");

    const file = req.file;
    if (!file) {
      throw new AppError(400, "File is required (multipart field name: 'file').");
    }

    const { document_type, filename } = req.body as {
      document_type?: KycDocumentType;
      filename?: string;
    };

    if (!document_type) {
      throw new AppError(400, "document_type is required.");
    }

    const document = await uploadKycDocument(seller.id, user.id, {
      document_type,
      file,
      filename: filename || file.originalname,
    });

    res.status(201).json({
      success: true,
      message: "Document uploaded successfully.",
      data: { document },
    });
  }
);

/**
 * DELETE /sellers/me/documents/:documentType
 */
export const deleteMyKycDocument = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireAuth(req);

    const seller = await getSellerByUserId(user.id);
    if (!seller) throw new AppError(404, "Seller profile not found.");

    const documentType = extractId(req.params.documentType) as KycDocumentType;

    await deleteKycDocument(seller.id, user.id, documentType);

    res.status(200).json({
      success: true,
      message: "Document deleted successfully.",
    });
  }
);

/**
 * PATCH /sellers/me/documents/:documentType/verify  (moderator or admin)
 */
export const verifySellerDocument = asyncHandler(
  async (req: Request, res: Response) => {
    requireModeratorOrAdmin(req);   // was requireAdmin(req)

    const sellerId = extractId(req.params.sellerId);
    const documentType = extractId(req.params.documentType) as KycDocumentType;
    const { verification_status, rejection_reason } = req.body as {
      verification_status: DocumentVerificationStatus;
      rejection_reason?: string;
    };

    if (!verification_status || !["verified", "rejected"].includes(verification_status)) {
      throw new AppError(400, "verification_status must be 'verified' or 'rejected'.");
    }

    const result = await verifyKycDocument(
      sellerId,
      documentType,
      verification_status as "verified" | "rejected",
      rejection_reason
    );

    res.status(200).json({
      success: true,
      message: result.sellerFullyVerified
        ? "Document verified. Seller is now fully verified."
        : `Document ${verification_status}.`,
      data: result,
    });
  }
);

// ============================================
// ADMIN: SELLERS LISTING
// ============================================

export const getAllSellers = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);

  // NOTE: req.query has already been coerced by getSellersQuerySchema
  // middleware. Pass it through directly.
  const result = await getSellers(req.query as any);

  res.status(200).json({
    success: true,
    data: result.sellers,
    summary: result.summary,
    pagination: result.pagination,
  });
});

export const getSellerByIdAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);

    const sellerId = extractId(req.params.sellerId);

    const seller = await getSellerById(sellerId);
    if (!seller) throw new AppError(404, "Seller not found.");

    const [statusCheck, metrics] = await Promise.all([
      checkSellerStatus(sellerId),
      getSellerMetrics(sellerId, "all"),
    ]);

    res.status(200).json({
      success: true,
      data: { seller, status: statusCheck, metrics },
    });
  }
);

// ============================================
// ADMIN: VERIFY / SUSPEND / REINSTATE
// ============================================

export const verifySeller = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);

  const sellerId = extractId(req.params.sellerId);
  const { status, reason, reviewer_notes, kyc_expiry_date } = req.body;

  if (!status || !["verified", "rejected"].includes(status)) {
    throw new AppError(400, 'Invalid status. Must be "verified" or "rejected".');
  }

  const seller = await updateSellerVerification(
    sellerId,
    status,
    reason,
    reviewer_notes,
    kyc_expiry_date ? new Date(kyc_expiry_date) : undefined
  );

  res.status(200).json({
    success: true,
    message: `Seller ${status} successfully.`,
    data: seller,
  });
});

export const suspendSellerProfile = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);

    const sellerId = extractId(req.params.sellerId);
    const {
      reason,
      notes,
      suspend_stores = true,
      notify_seller = true,
    } = req.body;

    if (!reason) throw new AppError(400, "Suspension reason is required.");

    const seller = await suspendSeller(
      sellerId,
      reason,
      notes,
      suspend_stores,
      notify_seller
    );

    res.status(200).json({
      success: true,
      message: `Seller suspended successfully.${
        suspend_stores ? " All stores have been suspended." : ""
      }`,
      data: seller,
    });
  }
);

export const reinstateSellerProfile = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);

    const sellerId = extractId(req.params.sellerId);
    const {
      reason,
      notes,
      reinstate_stores = true,
      notify_seller = true,
    } = req.body;

    const seller = await reinstateSeller(
      sellerId,
      reason,
      notes,
      reinstate_stores,
      notify_seller
    );

    res.status(200).json({
      success: true,
      message: `Seller reinstated successfully.${
        reinstate_stores ? " All stores have been reinstated." : ""
      }`,
      data: seller,
    });
  }
);

export const updateSellerTierAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);

    const sellerId = extractId(req.params.sellerId);
    const {
      tier,
      reason,
      effective_from,
      max_stores_allowed,
      max_products_per_store,
    } = req.body;

    if (!tier) throw new AppError(400, "Tier is required.");
    if (!reason) throw new AppError(400, "Reason is required for tier change.");

    const seller = await updateSellerTier(
      sellerId,
      tier,
      reason,
      effective_from ? new Date(effective_from) : undefined,
      max_stores_allowed,
      max_products_per_store
    );

    res.status(200).json({
      success: true,
      message: `Seller tier updated to ${tier} successfully.`,
      data: seller,
    });
  }
);

// ============================================
// ADMIN: SELLER STATS
// ============================================

export const getSellerStatsAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);

    const overviewResult = await pool.query(
      `SELECT 
        COUNT(*) as total_sellers,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'kyc_submitted' THEN 1 END) as kyc_submitted_count,
        COUNT(CASE WHEN status = 'kyc_update_pending' THEN 1 END) as kyc_update_pending_count,
        COUNT(CASE WHEN status = 'verified' THEN 1 END) as verified_count,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected_count,
        COUNT(CASE WHEN status = 'suspended' THEN 1 END) as suspended_count,
        AVG(rating) as avg_rating,
        SUM(total_orders) as total_orders,
        SUM(total_products) as total_products,
        SUM(total_stores) as total_stores
      FROM sellers`
    );

    const tierResult = await pool.query(
      `SELECT tier, COUNT(*) as count FROM sellers GROUP BY tier`
    );

    const recentResult = await pool.query(
      `SELECT 
        DATE(created_at) as date,
        COUNT(*) as count
      FROM sellers
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC`
    );

    res.status(200).json({
      success: true,
      data: {
        overview: overviewResult.rows[0],
        tier_distribution: tierResult.rows,
        recent_signups: recentResult.rows,
      },
    });
  }
);


export const verifySellerBulkController = asyncHandler(
  async (req: Request, res: Response) => {
    requireModeratorOrAdmin(req);   // was requireAdmin(req)

    const sellerId = extractId(req.params.sellerId);
    const { reason, kyc_expiry_date } = req.body as {
      reason?: string;
      kyc_expiry_date?: string;
    };

    const seller = await verifySellerBulk(
      sellerId,
      req.user!.id,
      reason,
      kyc_expiry_date ? new Date(kyc_expiry_date) : undefined
    );

    res.status(200).json({
      success: true,
      message: "Seller and all documents verified successfully.",
      data: seller,
    });
  }
);