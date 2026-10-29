// src/sellers/seller.service.ts

import { pool } from "../../config/db";
import cloudinaryService from "../../services/cloudinary.service";
import { AppError } from "../../utils/response";
import { AuthUser } from "../auth/auth.types";
import {
  CreateSellerInput,
  UpdateSellerInput,
  SellerProfile,
  SellerStatus,
  SellerTier,
  PayoutMethod,
  PayoutSchedule,
  BusinessType,
  SellerStatusCheck,
  SellerSetupProgress,
  SellerSetupStep,
  SellerMetrics,
  DocumentReference,
  DocumentVerificationStatus,
  KycDocumentType,
  SellerWebhookPayload,
  SellerEventType,
  UploadKycDocumentInput,
  //KYC_DOCUMENT_REQUIREMENTS,
  getRequiredDocumentsForSeller,
} from "./seller.types";
import {
  getTierLimits,
  requiresKycVerification,
} from "./seller.validator";

// ============================================
// UTILITY FUNCTIONS
// ============================================

export const encrypt = (text: string): string => {
  if (!text) return text;
  return Buffer.from(text).toString("base64");
};

export const decrypt = (encrypted: string): string => {
  if (!encrypted) return encrypted;
  return Buffer.from(encrypted, "base64").toString("utf-8");
};

export const publishEvent = async <T>(payload: T): Promise<void> => {
  try {
    // await redis.publish('seller_events', JSON.stringify(payload));
  } catch (error) {
    console.error("Failed to publish event:", error);
  }
};

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_COMMISSION_RATE = 0.15;
const DEFAULT_MINIMUM_PAYOUT = 10.0;
const DEFAULT_HOLD_PERIOD_DAYS = 7;
const KYC_EXPIRY_DAYS = 365;

// ============================================
// HELPERS
// ============================================

/**
 * Safely parse a JSONB column that may arrive as:
 *  - an already-parsed array (pg jsonb)
 *  - a JSON string
 *  - null / undefined
 */
const parseJsonArray = <T>(value: unknown): T[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};

/**
 * Determine which document types are required for a given seller.
 * Adds BANK_STATEMENT when payout_method === bank.
 */
const getRequiredDocsForSeller = (seller: {
  business_type: BusinessType;
  payout_method: PayoutMethod;
}): KycDocumentType[] => {
  return getRequiredDocumentsForSeller(
    seller.business_type as BusinessType,
    seller.payout_method as PayoutMethod
  );
};

// ============================================
// HELPER: Map DB Row to SellerProfile
// ============================================

const mapRowToSellerProfile = (row: any): SellerProfile => {
  const kycDocs: DocumentReference[] = parseJsonArray<DocumentReference>(row.kyc_documents);

  return {
    id: row.id,
    user_id: row.user_id,

    legal_business_name: row.business_name,
    trading_name: row.trading_name,
    business_type: row.business_type,
    tax_id: row.tax_id ? decrypt(row.tax_id) : "",
    registration_number: row.registration_number,
    country: row.country,
    state: row.state,
    city: row.city,
    business_address: row.business_address,
    business_phone: row.business_phone,

    status: row.status || SellerStatus.PENDING,
    verification_status: row.verification_status || "pending",
    risk_score: row.risk_score || 0,
    kyc_expiry_date: row.kyc_expiry_date,
    last_kyc_review_date: row.last_kyc_review_date,
    kyc_documents: kycDocs,
    verified_at: row.verified_at,
    rejected_reason: row.rejected_reason,
    suspension_reason: row.suspended_reason,
    suspension_date: row.suspended_at,

    payout_method: row.payout_method || PayoutMethod.BANK,
    bank_account_name: row.bank_account_name ? decrypt(row.bank_account_name) : undefined,
    bank_account_number: row.bank_account_number ? decrypt(row.bank_account_number) : undefined,
    bank_routing_number: row.bank_routing_number ? decrypt(row.bank_routing_number) : undefined,
    bank_name: row.bank_name ? decrypt(row.bank_name) : undefined,
    bank_country: row.bank_country,
    paypal_email: row.paypal_email,
    mpesa_phone: row.mpesa_phone,
    stripe_connect_id: row.stripe_connect_id,

    commission_rate: row.commission_rate || DEFAULT_COMMISSION_RATE,
    custom_commission_rate: row.custom_commission_rate,
    payout_schedule: row.payout_schedule || PayoutSchedule.WEEKLY,
    minimum_payout: row.minimum_payout || DEFAULT_MINIMUM_PAYOUT,
    currency: row.currency || "USD",
    hold_period_days: row.hold_period_days || DEFAULT_HOLD_PERIOD_DAYS,

    tier: row.tier || SellerTier.BASIC,
    max_stores_allowed: row.max_stores_allowed || 1,
    max_products_per_store: row.max_products_per_store || 100,
    auto_approve_products: row.auto_approve_products || false,
    enable_negotiation: row.enable_negotiation ?? true,
    allow_backorders: row.allow_backorders || false,
    allow_preorders: row.allow_preorders || false,

    rating: row.rating || 0,
    total_reviews: row.total_reviews || 0,
    total_orders: row.total_orders || 0,
    total_products: row.total_products || 0,
    total_stores: row.total_stores || 0,
    fulfillment_rate: row.fulfillment_rate || 100,
    response_rate: row.response_rate || 100,
    response_time_hours: row.response_time_hours,
    cancellation_rate: row.cancellation_rate || 0,
    dispute_rate: row.dispute_rate || 0,

    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    metadata: row.metadata,
  };
};

// ============================================
// HELPER: Get User with Seller Data
// ============================================

export const getUserWithSellerData = async (
  userId: string
): Promise<{ user: AuthUser; seller: SellerProfile | null } | null> => {
  const result = await pool.query(
    `SELECT 
      u.id, u.email, u.full_name, u.role, u.phone, u.is_active,
      u.created_at, u.updated_at,
      s.*,
      s.created_at as seller_created_at,
      s.updated_at as seller_updated_at
    FROM users u
    LEFT JOIN sellers s ON s.user_id = u.id
    WHERE u.id = $1`,
    [userId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const user: AuthUser = {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    phone: row.phone,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  const seller: SellerProfile | null = row.seller_id ? mapRowToSellerProfile(row) : null;

  return { user, seller };
};

// ============================================
// CREATE SELLER PROFILE
// ============================================

export const createSellerProfile = async (
  userId: string,
  input: CreateSellerInput,
  createdBy?: string
): Promise<SellerProfile> => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userCheck = await client.query(
      `SELECT id, role FROM users WHERE id = $1`,
      [userId]
    );

    if (userCheck.rows.length === 0) throw new AppError(404, "User not found.");
    if (userCheck.rows[0].role !== "seller") {
      throw new AppError(403, "Only sellers can create seller profiles.");
    }

    const existingSeller = await client.query(
      `SELECT id FROM sellers WHERE user_id = $1`,
      [userId]
    );
    if (existingSeller.rows.length > 0) {
      throw new AppError(409, "Seller profile already exists.");
    }

    const businessNameCheck = await client.query(
      `SELECT id FROM sellers WHERE business_name = $1`,
      [input.legal_business_name]
    );
    if (businessNameCheck.rows.length > 0) {
      throw new AppError(409, "Business name is already taken.");
    }

    const tier = SellerTier.BASIC;
    const tierLimits = getTierLimits(tier);
    const slug = input.legal_business_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const result = await client.query(
      `INSERT INTO sellers (
        user_id, business_name, trading_name, business_type,
        tax_id, registration_number, country, state, city,
        business_address, business_phone,
        store_name, store_url_slug,
        payout_method, bank_account_name, bank_account_number,
        bank_routing_number, bank_name, bank_country,
        paypal_email, mpesa_phone, stripe_connect_id,
        currency, commission_rate, payout_schedule, minimum_payout,
        hold_period_days, tier, max_stores_allowed, max_products_per_store,
        auto_approve_products, enable_negotiation,
        allow_backorders, allow_preorders,
        verification_status, status, kyc_documents,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
        $31, $32, $33, $34, $35, $36, $37::jsonb,
        NOW(), NOW()
      )
      RETURNING *`,
      [
        userId,
        input.legal_business_name,
        input.trading_name,
        input.business_type,
        input.tax_id ? encrypt(input.tax_id) : null,
        input.registration_number,
        input.country,
        input.state,
        input.city,
        input.business_address,
        input.business_phone,
        input.legal_business_name,
        slug,
        input.payout_method,
        input.bank_account_name ? encrypt(input.bank_account_name) : null,
        input.bank_account_number ? encrypt(input.bank_account_number) : null,
        input.bank_routing_number ? encrypt(input.bank_routing_number) : null,
        input.bank_name ? encrypt(input.bank_name) : null,
        input.bank_country || null,
        input.paypal_email || null,
        input.mpesa_phone || null,
        null,
        input.currency || "USD",
        DEFAULT_COMMISSION_RATE * 100,
        input.payout_schedule || PayoutSchedule.WEEKLY,
        input.minimum_payout ?? DEFAULT_MINIMUM_PAYOUT,
        input.hold_period_days ?? DEFAULT_HOLD_PERIOD_DAYS,
        tier,
        tierLimits.max_stores_allowed,
        tierLimits.max_products_per_store,
        false,
        true,
        false,
        false,
        "pending",
        "pending",
        JSON.stringify([]),
      ]
    );

    await client.query("COMMIT");

    const seller = mapRowToSellerProfile(result.rows[0]);

    await publishEvent<SellerWebhookPayload<SellerProfile>>({
      event_type: SellerEventType.SELLER_CREATED,
      seller_id: seller.id,
      user_id: userId,
      timestamp: new Date().toISOString(),
      current_data: seller,
      triggered_by: createdBy ? "admin" : "seller",
    });

    return seller;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// GET SELLER
// ============================================

export const getSellerByUserId = async (userId: string): Promise<SellerProfile | null> => {
  const result = await pool.query(`SELECT * FROM sellers WHERE user_id = $1`, [userId]);
  return result.rows.length === 0 ? null : mapRowToSellerProfile(result.rows[0]);
};

export const getSellerById = async (sellerId: string): Promise<SellerProfile | null> => {
  const result = await pool.query(`SELECT * FROM sellers WHERE id = $1`, [sellerId]);
  return result.rows.length === 0 ? null : mapRowToSellerProfile(result.rows[0]);
};

// ============================================
// UPDATE SELLER PROFILE
// ============================================

export const updateSellerProfile = async (
  userId: string,
  input: UpdateSellerInput,
  updatedBy?: string
): Promise<{ seller: SellerProfile; kycRequired: boolean }> => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const seller = await getSellerByUserId(userId);
    if (!seller) throw new AppError(404, "Seller profile not found.");

    if (seller.status === SellerStatus.SUSPENDED) {
      throw new AppError(403, "Seller account is suspended. Cannot update profile.");
    }

    const kycRequired = requiresKycVerification(input);

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    const fieldMap: Record<string, string> = {
      legal_business_name: "business_name",
      trading_name: "trading_name",
      business_type: "business_type",
      tax_id: "tax_id",
      registration_number: "registration_number",
      country: "country",
      state: "state",
      city: "city",
      business_address: "business_address",
      business_phone: "business_phone",
      payout_method: "payout_method",
      bank_account_name: "bank_account_name",
      bank_account_number: "bank_account_number",
      bank_routing_number: "bank_routing_number",
      bank_name: "bank_name",
      bank_country: "bank_country",
      paypal_email: "paypal_email",
      mpesa_phone: "mpesa_phone",
      currency: "currency",
      payout_schedule: "payout_schedule",
      minimum_payout: "minimum_payout",
      hold_period_days: "hold_period_days",
      auto_approve_products: "auto_approve_products",
      enable_negotiation: "enable_negotiation",
      allow_backorders: "allow_backorders",
      allow_preorders: "allow_preorders",
    };

    const sensitiveFields = new Set([
      "tax_id",
      "bank_account_name",
      "bank_account_number",
      "bank_routing_number",
      "bank_name",
    ]);

    for (const [inputField, dbField] of Object.entries(fieldMap)) {
      const value = input[inputField as keyof UpdateSellerInput];
      if (value !== undefined && value !== null) {
        const finalValue =
          sensitiveFields.has(inputField) && typeof value === "string"
            ? encrypt(value)
            : value;
        updates.push(`${dbField} = $${paramCount}`);
        values.push(finalValue);
        paramCount++;
      }
    }

    if (kycRequired) {
      updates.push(`status = $${paramCount}`);
      values.push(SellerStatus.KYC_UPDATE_PENDING);
      paramCount++;
      updates.push(`last_kyc_review_date = $${paramCount}`);
      values.push(new Date());
      paramCount++;
    }

    updates.push(`updated_at = NOW()`);
    if (updatedBy) {
      updates.push(`updated_by = $${paramCount}`);
      values.push(updatedBy);
      paramCount++;
    }

    if (updates.length === 0) throw new AppError(400, "No fields to update.");

    const query = `
      UPDATE sellers 
      SET ${updates.join(", ")}
      WHERE user_id = $${paramCount}
      RETURNING *
    `;
    values.push(userId);

    const result = await client.query(query, values);
    await client.query("COMMIT");

    const updatedSeller = mapRowToSellerProfile(result.rows[0]);

    await publishEvent<SellerWebhookPayload<SellerProfile>>({
      event_type: SellerEventType.SELLER_UPDATED,
      seller_id: updatedSeller.id,
      user_id: userId,
      timestamp: new Date().toISOString(),
      previous_data: seller,
      current_data: updatedSeller,
      triggered_by: updatedBy ? "admin" : "seller",
    });

    return { seller: updatedSeller, kycRequired };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// KYC DOCUMENT OPERATIONS (Cloudinary)
// ============================================

export const uploadKycDocument = async (
  sellerId: string,
  userId: string,
  input: UploadKycDocumentInput
): Promise<DocumentReference> => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sellerResult = await client.query(
      `SELECT id, user_id, business_type, payout_method, kyc_documents, status
       FROM sellers WHERE id = $1`,
      [sellerId]
    );

    if (sellerResult.rows.length === 0) throw new AppError(404, "Seller not found.");

    const seller = sellerResult.rows[0];

    if (seller.user_id !== userId) {
      throw new AppError(403, "You can only upload documents for your own seller profile.");
    }

    if (seller.status === SellerStatus.SUSPENDED) {
      throw new AppError(403, "Cannot upload documents for a suspended seller.");
    }

    // Validate the document type is required for this seller
    const requiredDocs = getRequiredDocsForSeller({
      business_type: seller.business_type,
      payout_method: seller.payout_method,
    });

    if (!requiredDocs.includes(input.document_type)) {
      throw new AppError(
        400,
        `Document type '${input.document_type}' is not required for your business type.`
      );
    }

    // Upload to Cloudinary
    const uploadResult = await cloudinaryService.uploadKycDocument({
      sellerId,
      documentType: input.document_type,
      file: input.file,
      filename: input.filename,
    });

    const docRef: DocumentReference = {
      type: input.document_type,
      public_id: uploadResult.public_id,
      url: uploadResult.secure_url,
      filename: input.filename,
      mime_type: `application/${uploadResult.format}`,
      size_bytes: uploadResult.bytes,
      uploaded_at: new Date(),
      verification_status: "pending",
    };

    const existingDocs = parseJsonArray<DocumentReference>(seller.kyc_documents);
    const previousDoc = existingDocs.find((d) => d.type === input.document_type);
    const filteredDocs = existingDocs.filter((d) => d.type !== input.document_type);
    filteredDocs.push(docRef);

    await client.query(
      `UPDATE sellers 
       SET kyc_documents = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(filteredDocs), sellerId]
    );

    if (previousDoc) {
      try {
        await cloudinaryService.deleteDocument(previousDoc.public_id);
      } catch (err) {
        console.error("Failed to delete previous Cloudinary doc:", err);
      }
    }

    await client.query("COMMIT");

    await publishEvent<SellerWebhookPayload<DocumentReference>>({
      event_type: SellerEventType.SELLER_DOCUMENT_UPLOADED,
      seller_id: sellerId,
      user_id: userId,
      timestamp: new Date().toISOString(),
      current_data: docRef,
      triggered_by: "seller",
    });

    return docRef;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const deleteKycDocument = async (
  sellerId: string,
  userId: string,
  documentType: KycDocumentType
): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sellerResult = await client.query(
      `SELECT id, user_id, kyc_documents, status FROM sellers WHERE id = $1`,
      [sellerId]
    );

    if (sellerResult.rows.length === 0) throw new AppError(404, "Seller not found.");

    const seller = sellerResult.rows[0];

    if (seller.user_id !== userId) {
      throw new AppError(403, "You can only delete your own documents.");
    }

    if (seller.status === SellerStatus.SUSPENDED) {
      throw new AppError(403, "Cannot modify documents for a suspended seller.");
    }

    const existingDocs = parseJsonArray<DocumentReference>(seller.kyc_documents);
    const docToDelete = existingDocs.find((d) => d.type === documentType);

    if (!docToDelete) throw new AppError(404, "Document not found.");

    if (docToDelete.verification_status === "verified") {
      throw new AppError(
        409,
        "Cannot delete a verified document. Contact support to update verified KYC documents."
      );
    }

    const filteredDocs = existingDocs.filter((d) => d.type !== documentType);

    await client.query(
      `UPDATE sellers 
       SET kyc_documents = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(filteredDocs), sellerId]
    );

    try {
      await cloudinaryService.deleteDocument(docToDelete.public_id);
    } catch (err) {
      console.error("Failed to delete Cloudinary doc:", err);
    }

    await client.query("COMMIT");

    await publishEvent<SellerWebhookPayload<{ document_type: KycDocumentType }>>({
      event_type: SellerEventType.SELLER_DOCUMENT_DELETED,
      seller_id: sellerId,
      user_id: userId,
      timestamp: new Date().toISOString(),
      current_data: { document_type: documentType },
      triggered_by: "seller",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const verifyKycDocument = async (
  sellerId: string,
  documentType: KycDocumentType,
  verificationStatus: DocumentVerificationStatus,
  rejectionReason?: string
): Promise<{ document: DocumentReference; sellerFullyVerified: boolean }> => {
  if (verificationStatus === "pending") {
    throw new AppError(400, "Cannot set a document back to pending.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sellerResult = await client.query(
      `SELECT id, user_id, business_type, payout_method, kyc_documents, status
       FROM sellers WHERE id = $1`,
      [sellerId]
    );

    if (sellerResult.rows.length === 0) throw new AppError(404, "Seller not found.");

    const seller = sellerResult.rows[0];
    const docs = parseJsonArray<DocumentReference>(seller.kyc_documents);

    const docIndex = docs.findIndex((d) => d.type === documentType);
    if (docIndex === -1) throw new AppError(404, "Document not found on seller.");

    docs[docIndex] = {
      ...docs[docIndex],
      verification_status: verificationStatus,
      verified_at: verificationStatus === "verified" ? new Date() : undefined,
      rejection_reason: verificationStatus === "rejected" ? rejectionReason : undefined,
    };

    await client.query(
      `UPDATE sellers 
       SET kyc_documents = $1::jsonb,
           last_kyc_review_date = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(docs), sellerId]
    );

    const requiredDocs = getRequiredDocsForSeller(seller);
    const allVerified = requiredDocs.every((t) => {
      const d = docs.find((x) => x.type === t);
      return d && d.verification_status === "verified";
    });

    let sellerFullyVerified = false;

    if (allVerified) {
      const kycExpiry = new Date(Date.now() + KYC_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      await client.query(
        `UPDATE sellers 
         SET status = 'verified',
             verification_status = 'verified',
             verified_at = NOW(),
             kyc_expiry_date = $1,
             rejected_reason = NULL,
             updated_at = NOW()
         WHERE id = $2`,
        [kycExpiry, sellerId]
      );
      sellerFullyVerified = true;

      await publishEvent<SellerWebhookPayload<{ seller_id: string; status: SellerStatus }>>({
        event_type: SellerEventType.SELLER_VERIFIED,
        seller_id: sellerId,
        user_id: seller.user_id,
        timestamp: new Date().toISOString(),
        current_data: { seller_id: sellerId, status: SellerStatus.VERIFIED },
        triggered_by: "admin",
      });
    } else if (verificationStatus === "rejected") {
      await client.query(
        `UPDATE sellers 
         SET status = 'rejected',
             verification_status = 'rejected',
             rejected_reason = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [rejectionReason || `Document ${documentType} rejected`, sellerId]
      );
    }

    await client.query("COMMIT");

    await publishEvent<SellerWebhookPayload<DocumentReference>>({
      event_type:
        verificationStatus === "verified"
          ? SellerEventType.SELLER_DOCUMENT_VERIFIED
          : SellerEventType.SELLER_DOCUMENT_REJECTED,
      seller_id: sellerId,
      user_id: seller.user_id,
      timestamp: new Date().toISOString(),
      current_data: docs[docIndex],
      triggered_by: "admin",
    });

    return { document: docs[docIndex], sellerFullyVerified };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// CHECK SELLER STATUS
// ============================================

export const checkSellerStatus = async (sellerId: string): Promise<SellerStatusCheck> => {
  const result = await pool.query(
    `SELECT 
      s.id, s.user_id, s.status, s.verification_status,
      s.kyc_expiry_date, s.suspended_at, s.suspended_reason,
      s.tier, s.max_stores_allowed,
      s.business_type, s.payout_method, s.kyc_documents,
      s.business_name, s.trading_name, s.tax_id,
      s.registration_number, s.country, s.state, s.city,
      s.business_address, s.business_phone,
      s.bank_account_name, s.bank_account_number,
      s.bank_routing_number, s.bank_name, s.bank_country,
      s.paypal_email, s.mpesa_phone,
      COUNT(st.id) as store_count
    FROM sellers s
    LEFT JOIN stores st ON st.seller_id = s.id AND st.deleted_at IS NULL
    WHERE s.id = $1
    GROUP BY s.id`,
    [sellerId]
  );

  if (result.rows.length === 0) throw new AppError(404, "Seller not found.");

  const row = result.rows[0];
  const seller = mapRowToSellerProfile(row);

  const status = row.status as SellerStatus;
  const verificationStatus =
    (row.verification_status as DocumentVerificationStatus | "suspended") || "pending";
  const isSuspended = status === SellerStatus.SUSPENDED || row.suspended_at !== null;
  const isVerified = status === SellerStatus.VERIFIED || verificationStatus === "verified";
  const isActive = isVerified && !isSuspended;

  const storeCount = parseInt(row.store_count || "0", 10);
  const maxStores = row.max_stores_allowed || 1;
  const kycExpired = row.kyc_expiry_date
    ? new Date(row.kyc_expiry_date) < new Date()
    : false;
  const hasPendingKycUpdate = status === SellerStatus.KYC_UPDATE_PENDING;

  const missingFields = getMissingFields(seller);
  const requiredDocuments = getRequiredDocsForSeller(seller);
  const uploadedDocuments = (seller.kyc_documents || []).map((d) => d.type);
  const missingDocuments = requiredDocuments.filter((d) => !uploadedDocuments.includes(d));

  let onboardingStep: SellerSetupStep = SellerSetupStep.NONE;
  let onboardingComplete = false;

  if (isVerified) {
    onboardingStep = SellerSetupStep.COMPLETE;
    onboardingComplete = true;
  } else if (missingFields.length > 0) {
    onboardingStep = SellerSetupStep.BUSINESS_DETAILS;
  } else if (missingDocuments.length > 0) {
    onboardingStep = SellerSetupStep.KYC_DOCUMENTS;
  } else {
    onboardingStep = SellerSetupStep.PAYMENT_SETUP;
  }

  let canCreateStores = false;
  let canUpdateStores = false;
  let blockReason: string | undefined;
  let actionsRequired: string[] = [];

  if (isSuspended) {
    blockReason = row.suspended_reason || "Seller account is suspended.";
    actionsRequired = ["contact_support"];
  } else if (status === SellerStatus.PENDING || status === SellerStatus.KYC_SUBMITTED) {
    blockReason = "Seller verification is pending. Complete KYC verification.";
    actionsRequired =
      missingDocuments.length > 0 ? ["upload_documents"] : ["wait_for_verification"];
  } else if (status === SellerStatus.REJECTED) {
    blockReason = "Seller verification was rejected. Review and resubmit documents.";
    actionsRequired = ["resubmit_documents"];
  } else if (kycExpired) {
    blockReason = "Seller KYC has expired. Renew your verification.";
    actionsRequired = ["renew_kyc"];
  } else if (hasPendingKycUpdate) {
    blockReason = "Seller has a pending KYC update. Wait for verification.";
    actionsRequired = ["wait_for_verification"];
  } else if (isActive) {
    canCreateStores = storeCount < maxStores;
    canUpdateStores = true;
    if (!canCreateStores) {
      blockReason = `Maximum store limit (${maxStores}) reached.`;
      actionsRequired = ["upgrade_tier"];
    }
  }

  if (!canCreateStores && !blockReason && !isActive) {
    blockReason = "Seller account is not in good standing.";
    actionsRequired = ["contact_support"];
  }

  return {
    status,
    verification_status: verificationStatus,
    is_active: isActive,
    can_create_stores: canCreateStores,
    can_update_stores: canUpdateStores,
    has_pending_kyc_update: hasPendingKycUpdate,
    kyc_expired: kycExpired,
    current_store_count: storeCount,
    max_stores_allowed: maxStores,
    can_create_more_stores: canCreateStores,
    block_reason: blockReason,
    actions_required: actionsRequired.length > 0 ? actionsRequired : undefined,
    onboarding_step: onboardingStep,
    onboarding_complete: onboardingComplete,
    missing_fields: missingFields,
    missing_documents: missingDocuments,
  };
};

// ============================================
// UPDATE SELLER VERIFICATION (Admin override)
// ============================================

export const updateSellerVerification = async (
  sellerId: string,
  status: "verified" | "rejected",
  reason?: string,
  reviewerNotes?: string,
  kycExpiryDate?: Date
): Promise<SellerProfile> => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (status === "verified") {
      const check = await client.query(
        `SELECT business_type, payout_method, kyc_documents FROM sellers WHERE id = $1`,
        [sellerId]
      );

      if (check.rows.length === 0) throw new AppError(404, "Seller not found.");

      const seller = check.rows[0];
      const docs = parseJsonArray<DocumentReference>(seller.kyc_documents);
      const requiredDocs = getRequiredDocsForSeller(seller);

      const allVerified = requiredDocs.every((t) => {
        const d = docs.find((x) => x.type === t);
        return d && d.verification_status === "verified";
      });

      if (!allVerified) {
        throw new AppError(
          400,
          "Cannot manually verify: not all required KYC documents are verified."
        );
      }
    }

    const result = await client.query(
      `UPDATE sellers 
       SET status = $1,
           verification_status = $1,
           verified_at = $2,
           rejected_reason = $3,
           kyc_expiry_date = $4,
           last_kyc_review_date = NOW(),
           metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{reviewer_notes}',
             $5::jsonb
           ),
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        status,
        status === "verified" ? new Date() : null,
        reason || null,
        status === "verified"
          ? kycExpiryDate || new Date(Date.now() + KYC_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
          : null,
        JSON.stringify(reviewerNotes || null),
        sellerId,
      ]
    );

    if (result.rows.length === 0) throw new AppError(404, "Seller not found.");

    await client.query("COMMIT");

    const updated = mapRowToSellerProfile(result.rows[0]);

    await publishEvent<SellerWebhookPayload<SellerProfile>>({
      event_type:
        status === "verified"
          ? SellerEventType.SELLER_VERIFIED
          : SellerEventType.SELLER_REJECTED,
      seller_id: updated.id,
      user_id: updated.user_id,
      timestamp: new Date().toISOString(),
      current_data: updated,
      triggered_by: "admin",
    });

    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// SUSPEND SELLER
// ============================================

export const suspendSeller = async (
  sellerId: string,
  reason: string,
  notes?: string,
  suspendStores: boolean = true,
  _notifySeller: boolean = true
): Promise<SellerProfile> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seller = await getSellerById(sellerId);
    if (!seller) throw new AppError(404, "Seller not found.");
    if (seller.status === SellerStatus.SUSPENDED) {
      throw new AppError(409, "Seller is already suspended.");
    }

    const result = await client.query(
      `UPDATE sellers 
       SET status = 'suspended', verification_status = 'suspended',
           suspended_at = NOW(), suspended_reason = $1, updated_at = NOW(),
           metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{suspension_notes}', $2::jsonb)
       WHERE id = $3 RETURNING *`,
      [reason, JSON.stringify(notes || null), sellerId]
    );

    if (suspendStores) {
      await client.query(
        `UPDATE stores SET status = 'suspended', suspended_at = NOW(),
           suspended_reason = $1, updated_at = NOW()
         WHERE seller_id = $2 AND status != 'deleted'`,
        [`Seller suspended: ${reason}`, sellerId]
      );
    }

    await client.query("COMMIT");

    const suspended = mapRowToSellerProfile(result.rows[0]);
    await publishEvent<SellerWebhookPayload<SellerProfile>>({
      event_type: SellerEventType.SELLER_SUSPENDED,
      seller_id: suspended.id,
      user_id: suspended.user_id,
      timestamp: new Date().toISOString(),
      current_data: suspended,
      triggered_by: "admin",
    });

    return suspended;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// REINSTATE SELLER
// ============================================

export const reinstateSeller = async (
  sellerId: string,
  reason?: string,
  notes?: string,
  reinstateStores: boolean = true,
  _notifySeller: boolean = true
): Promise<SellerProfile> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seller = await getSellerById(sellerId);
    if (!seller) throw new AppError(404, "Seller not found.");
    if (seller.status !== SellerStatus.SUSPENDED) {
      throw new AppError(409, "Seller is not suspended.");
    }

    const isKycExpired = seller.kyc_expiry_date
      ? new Date(seller.kyc_expiry_date) < new Date()
      : false;
    const newStatus = isKycExpired ? SellerStatus.PENDING : SellerStatus.VERIFIED;

    const result = await client.query(
      `UPDATE sellers 
       SET status = $1, verification_status = $1,
           suspended_at = NULL, suspended_reason = NULL, updated_at = NOW(),
           metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{reinstatement_notes}', $2::jsonb)
       WHERE id = $3 RETURNING *`,
      [
        newStatus,
        JSON.stringify({ reason: reason || null, notes: notes || null }),
        sellerId,
      ]
    );

    if (reinstateStores) {
      await client.query(
        `UPDATE stores SET status = 'active', suspended_at = NULL,
           suspended_reason = NULL, updated_at = NOW()
         WHERE seller_id = $1 AND status = 'suspended'`,
        [sellerId]
      );
    }

    await client.query("COMMIT");

    const reinstated = mapRowToSellerProfile(result.rows[0]);
    await publishEvent<SellerWebhookPayload<SellerProfile>>({
      event_type: SellerEventType.SELLER_REINSTATED,
      seller_id: reinstated.id,
      user_id: reinstated.user_id,
      timestamp: new Date().toISOString(),
      current_data: reinstated,
      triggered_by: "admin",
    });

    return reinstated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// UPDATE SELLER TIER
// ============================================

export const updateSellerTier = async (
  sellerId: string,
  newTier: SellerTier,
  reason: string,
  effectiveFrom?: Date,
  overrideMaxStores?: number,
  overrideMaxProducts?: number
): Promise<SellerProfile> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seller = await getSellerById(sellerId);
    if (!seller) throw new AppError(404, "Seller not found.");
    if (seller.status === SellerStatus.SUSPENDED) {
      throw new AppError(403, "Cannot update tier for suspended seller.");
    }

    const tierLimits = getTierLimits(newTier);
    const maxStores = overrideMaxStores || tierLimits.max_stores_allowed;
    const maxProducts = overrideMaxProducts || tierLimits.max_products_per_store;

    const storeCount = await client.query(
      `SELECT COUNT(*) as count FROM stores WHERE seller_id = $1 AND status != 'deleted'`,
      [sellerId]
    );
    const currentStoreCount = parseInt(storeCount.rows[0].count, 10);
    if (currentStoreCount > maxStores) {
      throw new AppError(
        409,
        `Seller has ${currentStoreCount} stores. New tier allows only ${maxStores}.`
      );
    }

    const result = await client.query(
      `UPDATE sellers 
       SET tier = $1, max_stores_allowed = $2, max_products_per_store = $3, updated_at = NOW(),
           metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb), '{tier_update_history}',
             COALESCE(metadata->'tier_update_history', '[]'::jsonb) || $4::jsonb
           )
       WHERE id = $5 RETURNING *`,
      [
        newTier,
        maxStores,
        maxProducts,
        JSON.stringify([
          {
            from_tier: seller.tier,
            to_tier: newTier,
            reason,
            effective_from: effectiveFrom || new Date(),
            updated_at: new Date(),
          },
        ]),
        sellerId,
      ]
    );

    await client.query("COMMIT");

    const updated = mapRowToSellerProfile(result.rows[0]);
    await publishEvent<SellerWebhookPayload<SellerProfile>>({
      event_type: SellerEventType.SELLER_TIER_CHANGED,
      seller_id: updated.id,
      user_id: updated.user_id,
      timestamp: new Date().toISOString(),
      previous_data: seller,
      current_data: updated,
      triggered_by: "admin",
    });

    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// GET SELLER SETUP PROGRESS
// ============================================

export const getSellerSetupProgress = async (
  sellerId: string
): Promise<SellerSetupProgress> => {
  const seller = await getSellerById(sellerId);
  if (!seller) throw new AppError(404, "Seller not found.");

  const requiredDocuments = getRequiredDocsForSeller(seller);
  const uploadedDocuments = (seller.kyc_documents || []).map((d) => d.type);
  const missingDocs = requiredDocuments.filter(
    (d) => !uploadedDocuments.includes(d)
  );
  const missingFields = getMissingFields(seller);

  let currentStep: SellerSetupStep = SellerSetupStep.NONE;
  let isComplete = false;

  if (seller.status === SellerStatus.VERIFIED) {
    // Moderator approved everything
    currentStep = SellerSetupStep.COMPLETE;
    isComplete = true;
  } else if (
    missingFields.length === 0 &&
    missingDocs.length === 0
  ) {
    // Seller filled everything AND uploaded every doc.
    // Next action is on the moderator, not the seller.
    // We mark this as COMPLETE so the wizard stops nagging.
    // (Seller's actual verification state is on `status`, not on
    //  `onboarding_step`.)
    currentStep = SellerSetupStep.COMPLETE;
    isComplete = true;
  } else if (missingFields.length > 0) {
    currentStep = SellerSetupStep.BUSINESS_DETAILS;
  } else if (missingDocs.length > 0) {
    currentStep = SellerSetupStep.KYC_DOCUMENTS;
  }

  let nextStepAction: "upload_documents" | "configure_payout" | "create_store";
  if (isComplete) {
    nextStepAction = "create_store";
  } else if (currentStep === SellerSetupStep.KYC_DOCUMENTS) {
    nextStepAction = "upload_documents";
  } else {
    nextStepAction = "configure_payout";
  }

  return {
    currentStep,
    isComplete,
    missingFields,
    requiredDocuments,
    uploadedDocuments,
    nextStepAction,
  };
};

// ============================================
// GET SELLER METRICS
// ============================================

export const getSellerMetrics = async (
  sellerId: string,
  period: "today" | "week" | "month" | "year" | "all" = "month"
): Promise<SellerMetrics> => {
  const dateRange = getDateRange(period);

  const result = await pool.query(
    `SELECT 
      COALESCE(SUM(o.total_amount), 0) as total_revenue,
      COALESCE(SUM(o.platform_fee), 0) as platform_fees,
      COUNT(DISTINCT o.id) as total_orders,
      COUNT(DISTINCT CASE WHEN o.status = 'completed' THEN o.id END) as completed_orders,
      COUNT(DISTINCT CASE WHEN o.status = 'cancelled' THEN o.id END) as cancelled_orders,
      COUNT(DISTINCT CASE WHEN o.status = 'refunded' THEN o.id END) as refunded_orders,
      COALESCE(AVG(o.total_amount), 0) as average_order_value,
      COUNT(DISTINCT p.id) as total_products,
      COUNT(DISTINCT CASE WHEN p.status = 'active' THEN p.id END) as active_products,
      COUNT(DISTINCT CASE WHEN p.stock_quantity = 0 THEN p.id END) as out_of_stock_products,
      COUNT(DISTINCT st.id) as total_stores,
      COUNT(DISTINCT CASE WHEN st.status = 'active' THEN st.id END) as active_stores,
      COALESCE(AVG(r.rating), 0) as average_rating,
      COUNT(DISTINCT r.id) as total_reviews,
      COUNT(DISTINCT CASE WHEN r.rating >= 4 THEN r.id END) as positive_reviews,
      COUNT(DISTINCT CASE WHEN r.rating <= 2 THEN r.id END) as negative_reviews
    FROM sellers s
    LEFT JOIN stores st ON st.seller_id = s.id AND st.status != 'deleted'
    LEFT JOIN products p ON p.store_id = st.id AND p.status != 'deleted'
    LEFT JOIN orders o ON o.store_id = st.id
      AND o.created_at >= $2
      AND ($3::text IS NULL OR o.created_at <= $3)
    LEFT JOIN reviews r ON r.seller_id = s.id
      AND r.created_at >= $2
      AND ($3::text IS NULL OR r.created_at <= $3)
    WHERE s.id = $1
    GROUP BY s.id`,
    [sellerId, dateRange.startDate, dateRange.endDate || null]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, "Seller not found or no data available.");
  }

  const row = result.rows[0];
  return {
    seller_id: sellerId,
    period,
    total_revenue: parseFloat(row.total_revenue),
    revenue_by_currency: { USD: parseFloat(row.total_revenue) },
    platform_fees: parseFloat(row.platform_fees),
    net_payout: parseFloat(row.total_revenue) - parseFloat(row.platform_fees),
    total_orders: parseInt(row.total_orders, 10),
    completed_orders: parseInt(row.completed_orders, 10),
    cancelled_orders: parseInt(row.cancelled_orders, 10),
    refunded_orders: parseInt(row.refunded_orders, 10),
    average_order_value: parseFloat(row.average_order_value),
    total_products: parseInt(row.total_products, 10),
    active_products: parseInt(row.active_products, 10),
    out_of_stock_products: parseInt(row.out_of_stock_products, 10),
    total_stores: parseInt(row.total_stores, 10),
    active_stores: parseInt(row.active_stores, 10),
    average_rating: parseFloat(row.average_rating),
    total_reviews: parseInt(row.total_reviews, 10),
    positive_reviews: parseInt(row.positive_reviews, 10),
    negative_reviews: parseInt(row.negative_reviews, 10),
  };
};

// ============================================
// GET SELLERS
// ============================================

export interface GetSellersParams {
  page?: number;
  limit?: number;
  sortBy?: "rating" | "total_orders" | "created_at" | "fulfillment_rate" | "revenue";
  sortOrder?: "asc" | "desc";
  status?: SellerStatus[];
  country?: string[];
  tier?: SellerTier[];
  business_type?: BusinessType[];
  has_stores?: boolean;
  min_rating?: number;
  max_rating?: number;
  date_from?: Date;
  date_to?: Date;
  search?: string;
  min_revenue?: number;
  max_revenue?: number;
}

export const getSellers = async (params: GetSellersParams) => {
  const {
    page = 1,
    limit = 20,
    sortBy = "created_at",
    sortOrder = "desc",
    status,
    country,
    tier,
    business_type,
    has_stores,
    min_rating,
    max_rating,
    date_from,
    date_to,
    search,
  } = params;

  const offset = (page - 1) * limit;
  const conditions: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  if (status?.length) {
    conditions.push(`status = ANY($${paramCount})`);
    values.push(status);
    paramCount++;
  }
  if (country?.length) {
    conditions.push(`country = ANY($${paramCount})`);
    values.push(country);
    paramCount++;
  }
  if (tier?.length) {
    conditions.push(`tier = ANY($${paramCount})`);
    values.push(tier);
    paramCount++;
  }
  if (business_type?.length) {
    conditions.push(`business_type = ANY($${paramCount})`);
    values.push(business_type);
    paramCount++;
  }
  if (min_rating !== undefined) {
    conditions.push(`rating >= $${paramCount}`);
    values.push(min_rating);
    paramCount++;
  }
  if (max_rating !== undefined) {
    conditions.push(`rating <= $${paramCount}`);
    values.push(max_rating);
    paramCount++;
  }
  if (date_from) {
    conditions.push(`created_at >= $${paramCount}`);
    values.push(date_from);
    paramCount++;
  }
  if (date_to) {
    conditions.push(`created_at <= $${paramCount}`);
    values.push(date_to);
    paramCount++;
  }
  if (has_stores !== undefined) {
    conditions.push(has_stores ? `total_stores > 0` : `total_stores = 0`);
  }
  if (search) {
    conditions.push(
      `(business_name ILIKE $${paramCount} OR trading_name ILIKE $${paramCount} OR business_type ILIKE $${paramCount})`
    );
    values.push(`%${search}%`);
    paramCount++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM sellers s ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0]?.count || "0", 10);

  const query = `
    SELECT s.* FROM sellers s
    ${whereClause}
    ORDER BY ${sortBy} ${sortOrder}
    LIMIT $${paramCount} OFFSET $${paramCount + 1}
  `;
  values.push(limit, offset);
  const result = await pool.query(query, values);

  const summaryResult = await pool.query(
    `SELECT 
      COUNT(*) as total,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
      COUNT(CASE WHEN status = 'verified' THEN 1 END) as verified,
      COUNT(CASE WHEN status = 'suspended' THEN 1 END) as suspended,
      COALESCE(SUM(total_stores), 0) as total_stores,
      COALESCE(SUM(total_orders * COALESCE(commission_rate, 0)), 0) as total_revenue
    FROM sellers s ${whereClause}`,
    conditions.length > 0 ? values.slice(0, -2) : []
  );

  const summary = summaryResult.rows[0] || {};

  return {
    sellers: result.rows.map(mapRowToSellerProfile),
    summary: {
      total: parseInt(summary.total || "0", 10),
      pending: parseInt(summary.pending || "0", 10),
      verified: parseInt(summary.verified || "0", 10),
      suspended: parseInt(summary.suspended || "0", 10),
      total_stores: parseInt(summary.total_stores || "0", 10),
      total_revenue: parseFloat(summary.total_revenue || "0"),
    },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};

// ============================================
// HELPERS
// ============================================

export const getMissingFields = (seller: SellerProfile): string[] => {
  const missing: string[] = [];

  const requiredTextFields: (keyof SellerProfile)[] = [
    "legal_business_name",
    "trading_name",
    "business_type",
    "tax_id",
    "registration_number",
    "country",
    "state",
    "city",
    "business_address",
    "business_phone",
    "payout_method",
  ];

  for (const field of requiredTextFields) {
    if (!seller[field]) missing.push(field);
  }

  if (seller.payout_method === PayoutMethod.BANK) {
    if (!seller.bank_account_name) missing.push("bank_account_name");
    if (!seller.bank_account_number) missing.push("bank_account_number");
    if (!seller.bank_routing_number) missing.push("bank_routing_number");
    if (!seller.bank_name) missing.push("bank_name");
    if (!seller.bank_country) missing.push("bank_country");
  }
  if (seller.payout_method === PayoutMethod.MPESA && !seller.mpesa_phone) {
    missing.push("mpesa_phone");
  }
  if (seller.payout_method === PayoutMethod.PAYPAL && !seller.paypal_email) {
    missing.push("paypal_email");
  }

  return missing;
};

const getDateRange = (period: string): { startDate: Date; endDate?: Date } => {
  const now = new Date();
  let startDate: Date;
  let endDate: Date | undefined;

  switch (period) {
    case "today":
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now);
      endDate.setHours(23, 59, 59, 999);
      break;
    case "week":
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 7);
      break;
    case "month":
      startDate = new Date(now);
      startDate.setMonth(now.getMonth() - 1);
      break;
    case "year":
      startDate = new Date(now);
      startDate.setFullYear(now.getFullYear() - 1);
      break;
    default:
      startDate = new Date(0);
  }
  return { startDate, endDate };
};

export const sellerExists = async (userId: string): Promise<boolean> => {
  const result = await pool.query(`SELECT id FROM sellers WHERE user_id = $1`, [userId]);
  return result.rows.length > 0;
};

export const updateSellerMetrics = async (sellerId: string): Promise<void> => {
  await pool.query(
    `UPDATE sellers 
     SET 
       total_orders = (SELECT COUNT(*) FROM orders o JOIN stores st ON st.id = o.store_id WHERE st.seller_id = sellers.id AND o.status = 'completed'),
       total_products = (SELECT COUNT(*) FROM products p JOIN stores st ON st.id = p.store_id WHERE st.seller_id = sellers.id AND p.status = 'active'),
       total_stores = (SELECT COUNT(*) FROM stores WHERE seller_id = sellers.id AND status = 'active'),
       updated_at = NOW()
     WHERE id = $1`,
    [sellerId]
  );
};



// ============================================
// VERIFY SELLER + ALL DOCUMENTS AT ONCE (moderator bulk approve)
// ============================================

export const verifySellerBulk = async (
  sellerId: string,
  moderatorId: string,
  reason?: string,
  kycExpiryDate?: Date
): Promise<SellerProfile> => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sellerResult = await client.query(
      `SELECT id, user_id, business_type, payout_method, kyc_documents, status
       FROM sellers WHERE id = $1 FOR UPDATE`,
      [sellerId]
    );

    if (sellerResult.rows.length === 0) throw new AppError(404, "Seller not found.");

    const sellerRow = sellerResult.rows[0];

    if (sellerRow.status === SellerStatus.SUSPENDED) {
      throw new AppError(403, "Cannot verify a suspended seller.");
    }

    const requiredDocs = getRequiredDocsForSeller(sellerRow);
    const existingDocs = parseJsonArray<DocumentReference>(sellerRow.kyc_documents);

    // Every required document type must at least have been uploaded.
    const missingDocs = requiredDocs.filter(
      (t) => !existingDocs.some((d) => d.type === t)
    );
    if (missingDocs.length > 0) {
      throw new AppError(
        400,
        `Cannot verify seller: missing required documents (${missingDocs.join(", ")}).`
      );
    }

    // Mark every existing document verified (skip already-rejected ones —
    // a moderator bulk-approving shouldn't silently overturn a prior rejection).
    const now = new Date();
    const updatedDocs = existingDocs.map((d) =>
      d.verification_status === "rejected"
        ? d
        : {
            ...d,
            verification_status: "verified" as DocumentVerificationStatus,
            verified_at: now,
            rejection_reason: undefined,
          }
    );

    const stillRejected = updatedDocs.filter((d) => d.verification_status === "rejected");
    if (stillRejected.length > 0) {
      throw new AppError(
        409,
        `Cannot verify seller: ${stillRejected.length} document(s) are marked rejected. Resolve them first.`
      );
    }

    const kycExpiry =
      kycExpiryDate || new Date(Date.now() + KYC_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const result = await client.query(
      `UPDATE sellers 
       SET status = 'verified',
           verification_status = 'verified',
           verified_at = $1,
           kyc_expiry_date = $2,
           rejected_reason = NULL,
           kyc_documents = $3::jsonb,
           last_kyc_review_date = NOW(),
           updated_by = $4,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [now, kycExpiry, JSON.stringify(updatedDocs), moderatorId, sellerId]
    );

    await client.query("COMMIT");

    const updated = mapRowToSellerProfile(result.rows[0]);

    await publishEvent<SellerWebhookPayload<SellerProfile>>({
      event_type: SellerEventType.SELLER_VERIFIED,
      seller_id: updated.id,
      user_id: updated.user_id,
      timestamp: new Date().toISOString(),
      current_data: updated,
      triggered_by: "admin",
    });

    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};