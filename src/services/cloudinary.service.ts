// src/services/cloudinary.service.ts

import {
  uploadToCloudinary,
  deleteFromCloudinary,
  mediaUrl,
  type StoredAsset,
} from "../config/cloudinary";
import { KycDocumentType } from "../features/seller/seller.types";

const SELLER_KYC_FOLDER = "sellers";

export interface CloudinaryUploadResult {
  public_id: string;
  secure_url: string;
  format: string;
  bytes: number;
  original_filename: string;
  created_at: string;
}

interface UploadKycDocumentParams {
  sellerId: string;
  documentType: KycDocumentType;
  file: Express.Multer.File | string;
  filename: string;
}

export const cloudinaryService = {
  /**
   * Upload a KYC document for a seller to Cloudinary.
   * Folder structure: sellers/{sellerId}/kyc
   *
   * `uploadToCloudinary` returns a normalized `StoredAsset` — we build
   * the public URL with `mediaUrl` rather than reading `secure_url`
   * off the raw Cloudinary response.
   */
  async uploadKycDocument(
    params: UploadKycDocumentParams
  ): Promise<CloudinaryUploadResult> {
    const { sellerId, file, filename } = params;

    const folder = `${SELLER_KYC_FOLDER}/${sellerId}/kyc`;

    const result: StoredAsset = await uploadToCloudinary(file, folder);

    // Build a public URL from the normalized asset
    const secureUrl = mediaUrl(
      {
        publicId: result.publicId,
        resourceType: result.resourceType,
        format: result.format,
      },
      // no preset — KYC docs are returned at their original resolution
    );

    return {
      public_id: result.publicId,
      secure_url: secureUrl,
      format: result.format ?? "unknown",
      bytes: result.bytes,
      // StoredAsset doesn't carry `original_filename`, so use the value the
      // caller passed in (usually file.originalname).
      original_filename: filename,
      // StoredAsset doesn't carry `created_at` either — stamp it now.
      created_at: new Date().toISOString(),
    };
  },

  /**
   * Delete a document from Cloudinary.
   * KYC docs are always images or PDFs → resource_type "image".
   */
  async deleteDocument(publicId: string): Promise<void> {
    await deleteFromCloudinary(publicId, "image");
  },

  /**
   * Build the folder path for a seller's KYC documents.
   */
  buildKycFolder(sellerId: string): string {
    return `${SELLER_KYC_FOLDER}/${sellerId}/kyc`;
  },
};

export default cloudinaryService;