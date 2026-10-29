// src/middlewares/upload.middleware.ts

import multer, { FileFilterCallback, MulterError } from "multer";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/response";

// ============================================
// STORAGE
// ============================================

const storage = multer.memoryStorage();

// ============================================
// MIME TYPES
// ============================================

export const MIME_TYPES = {
  IMAGES: {
    "image/jpeg": ["jpg", "jpeg"],
    "image/png": ["png"],
    "image/webp": ["webp"],
    "image/gif": ["gif"],
    "image/svg+xml": ["svg"],
    "image/heic": ["heic"],
    "image/bmp": ["bmp"],
    "image/tiff": ["tiff", "tif"],
  },
  DOCUMENTS: {
    "application/pdf": ["pdf"],
    "application/msword": ["doc"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
    "application/vnd.ms-excel": ["xls"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
    "application/vnd.ms-powerpoint": ["ppt"],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
    "application/vnd.oasis.opendocument.text": ["odt"],
    "application/vnd.oasis.opendocument.spreadsheet": ["ods"],
    "application/vnd.oasis.opendocument.presentation": ["odp"],
    "application/rtf": ["rtf"],
  },
  TEXT: {
    "text/plain": ["txt"],
    "text/csv": ["csv"],
    "application/json": ["json"],
    "text/html": ["html", "htm"],
    "text/xml": ["xml"],
  },
  ARCHIVES: {
    "application/zip": ["zip"],
    "application/x-7z-compressed": ["7z"],
    "application/x-rar-compressed": ["rar"],
    "application/gzip": ["gz"],
    "application/x-tar": ["tar"],
  },
  VIDEOS: {
    "video/mp4": ["mp4"],
    "video/mpeg": ["mpeg"],
    "video/quicktime": ["mov"],
    "video/webm": ["webm"],
    "video/x-msvideo": ["avi"],
    "video/x-matroska": ["mkv"],
  },
  AUDIO: {
    "audio/mpeg": ["mp3"],
    "audio/wav": ["wav"],
    "audio/ogg": ["ogg"],
    "audio/aac": ["aac"],
    "audio/flac": ["flac"],
  },
} as const;

export const ALLOWED_MIME_TYPES: Record<string, readonly string[]> = {
  ...MIME_TYPES.IMAGES,
  ...MIME_TYPES.DOCUMENTS,
  ...MIME_TYPES.TEXT,
  ...MIME_TYPES.ARCHIVES,
  ...MIME_TYPES.VIDEOS,
  ...MIME_TYPES.AUDIO,
};

// ============================================
// FILTER FACTORY
// ============================================

interface FileFilterOptions {
  allowedTypes: readonly string[];
  customMessage: string;
}

const createFileFilter = (options: FileFilterOptions) => {
  return (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    if (options.allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, options.customMessage) as any, false);
    }
  };
};

// ============================================
// MIME GROUPS
// ============================================

const IMAGE_MIMES = Object.keys(MIME_TYPES.IMAGES);
const DOCUMENT_MIMES = Object.keys(MIME_TYPES.DOCUMENTS);
const TEXT_MIMES = Object.keys(MIME_TYPES.TEXT);
const ARCHIVE_MIMES = Object.keys(MIME_TYPES.ARCHIVES);
const VIDEO_MIMES = Object.keys(MIME_TYPES.VIDEOS);
const AUDIO_MIMES = Object.keys(MIME_TYPES.AUDIO);

const ANY_ALLOWED = [
  ...IMAGE_MIMES,
  ...DOCUMENT_MIMES,
  ...TEXT_MIMES,
  ...ARCHIVE_MIMES,
  ...VIDEO_MIMES,
  ...AUDIO_MIMES,
];

// ============================================
// FILTERS
// ============================================

export const avatarFilter = createFileFilter({
  allowedTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"],
  customMessage: "Avatar must be JPEG, PNG, WEBP, GIF, or SVG (max 5MB).",
});

export const logoFilter = createFileFilter({
  allowedTypes: ["image/jpeg", "image/png", "image/webp", "image/svg+xml"],
  customMessage: "Logo must be JPEG, PNG, WEBP, or SVG (max 2MB).",
});

export const bannerFilter = createFileFilter({
  allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  customMessage: "Banner must be JPEG, PNG, or WEBP (max 5MB).",
});

export const signatureFilter = createFileFilter({
  allowedTypes: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  customMessage: "Signature must be PNG, JPEG, WEBP, or SVG (max 2MB).",
});

export const templateFilter = createFileFilter({
  allowedTypes: [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.oasis.opendocument.text",
  ],
  customMessage: "Template must be a Word document (.doc, .docx, .odt) (max 15MB).",
});

export const documentFilter = createFileFilter({
  allowedTypes: ANY_ALLOWED,
  customMessage: "Unsupported format. Upload an image, PDF, document, archive, or video (max 55MB).",
});

export const governmentIDFilter = createFileFilter({
  allowedTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/tiff"],
  customMessage: "Government ID must be JPEG, PNG, WEBP, HEIC, or TIFF (max 10MB).",
});

export const kraCertificateFilter = createFileFilter({
  allowedTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  customMessage: "KRA certificate must be JPEG, PNG, WEBP, or PDF (max 5MB).",
});

export const businessRegistrationFilter = createFileFilter({
  allowedTypes: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  customMessage: "Business registration must be JPEG, PNG, WEBP, PDF, or Word (max 10MB).",
});

export const kycDocumentFilter = createFileFilter({
  allowedTypes: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/tiff",
    "application/pdf",
  ],
  customMessage:
    "KYC document must be JPEG, PNG, WEBP, HEIC, TIFF, or PDF (max 5MB).",
});

/**
 * ✅ NEW: product image filter.
 *
 * Product images get their own filter — stricter than `documentFilter`
 * but broader than `avatarFilter`. No PDFs, no videos, no SVG (SVG can
 * carry scripts and Cloudinary doesn't sanitize them consistently).
 *
 * Allowed: JPEG, PNG, WEBP, GIF, HEIC
 */
export const productImageFilter = createFileFilter({
  allowedTypes: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
  ],
  customMessage:
    "Product image must be JPEG, PNG, WEBP, GIF, or HEIC (max 10MB, up to 10 files).",
});

// ============================================
// MULTER INSTANCES
// ============================================

// ---- Profile-style single uploads ----

export const uploadAvatar = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: avatarFilter as any,
}).single("avatar");

export const uploadLogo = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: logoFilter as any,
}).single("logo");

export const uploadBanner = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: bannerFilter as any,
}).single("banner");

export const uploadSignature = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: signatureFilter as any,
}).single("signature");

export const uploadTemplate = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: templateFilter as any,
}).single("file");

// ---- Generic multi-file / single-file ----

export const uploadDocuments = multer({
  storage,
  limits: { fileSize: 55 * 1024 * 1024, files: 50 },
  fileFilter: documentFilter as any,
}).array("documents", 50);

export const uploadSingle = multer({
  storage,
  limits: { fileSize: 55 * 1024 * 1024, files: 1 },
  fileFilter: documentFilter as any,
}).single("file");

// ---- Legacy KYC-specific singles ----

export const uploadGovernmentID = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: governmentIDFilter as any,
}).single("file");

export const uploadKRACertificate = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: kraCertificateFilter as any,
}).single("file");

export const uploadBusinessRegistration = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: businessRegistrationFilter as any,
}).single("file");

// ---- KYC document upload ----

export const uploadKycDocument = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: kycDocumentFilter as any,
}).single("file");

/**
 * ✅ NEW: product images.
 *
 * Use on:
 *   POST /api/v1/products/stores/:storeId/products
 *   PUT  /api/v1/products/:productId
 *
 * Multipart expectations:
 *   - Field name: `images` (repeatable)
 *   - Up to 10 files per request
 *   - Each file max 10MB
 *   - All other product fields travel as regular string fields
 *     and are coerced by the request body parser
 */
export const uploadProductImages = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: productImageFilter as any,
}).array("images", 10);

// ============================================
// ERROR HANDLER
// ============================================

const MULTER_ERROR_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: "File too large.",
  LIMIT_FILE_COUNT: "Too many files.",
  LIMIT_UNEXPECTED_FILE: "Unexpected file field.",
  LIMIT_PART_COUNT: "Too many parts in the request.",
  LIMIT_FIELD_KEY: "Field name too long.",
  LIMIT_FIELD_VALUE: "Field value too long.",
  LIMIT_FIELD_COUNT: "Too many fields.",
};

export const handleMulterError = (
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction
): void => {
  if (err instanceof MulterError) {
    const message = MULTER_ERROR_MESSAGES[err.code] ?? `Upload error: ${err.message}`;
    return next(new AppError(400, message));
  }
  next(err);
};

// ============================================
// VALIDATORS
// ============================================

export const requireSingleFile =
  (fieldName: string = "file") =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return next(new AppError(400, `File "${fieldName}" is required.`));
    }
    next();
  };

export const requireFiles =
  (minCount: number = 1) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const files = (req as any).files as Express.Multer.File[] | undefined;
    if (!files || files.length < minCount) {
      return next(
        new AppError(
          400,
          `At least ${minCount} file(s) required. Received ${files?.length ?? 0}.`
        )
      );
    }
    next();
  };

// ============================================
// UTILITIES
// ============================================

export const getExtensionFromMimeType = (mimeType: string): string | null => {
  const exts = ALLOWED_MIME_TYPES[mimeType];
  return exts && exts.length > 0 ? exts[0] : null;
};

export const getAllowedExtensions = (mimeType: string): readonly string[] =>
  ALLOWED_MIME_TYPES[mimeType] ?? [];

export const isFileTypeAllowed = (mimeType: string): boolean =>
  mimeType in ALLOWED_MIME_TYPES;

export type UploadCategory =
  | "image"
  | "avatar"
  | "logo"
  | "banner"
  | "signature"
  | "template"
  | "document"
  | "text"
  | "archive"
  | "video"
  | "audio"
  | "government_id"
  | "kra_certificate"
  | "business_registration"
  | "kyc_document"
  | "product_image";

export const getMaxFileSize = (type: UploadCategory): number => {
  const sizes: Record<UploadCategory, number> = {
    image: 10 * 1024 * 1024,
    avatar: 5 * 1024 * 1024,
    logo: 2 * 1024 * 1024,
    banner: 5 * 1024 * 1024,
    signature: 2 * 1024 * 1024,
    template: 15 * 1024 * 1024,
    document: 55 * 1024 * 1024,
    text: 10 * 1024 * 1024,
    archive: 100 * 1024 * 1024,
    video: 200 * 1024 * 1024,
    audio: 50 * 1024 * 1024,
    government_id: 10 * 1024 * 1024,
    kra_certificate: 5 * 1024 * 1024,
    business_registration: 10 * 1024 * 1024,
    kyc_document: 5 * 1024 * 1024,
    product_image: 10 * 1024 * 1024,
  };
  return sizes[type] ?? 55 * 1024 * 1024;
};

// ============================================
// DEFAULT EXPORT
// ============================================

export default {
  // Instances
  uploadAvatar,
  uploadLogo,
  uploadBanner,
  uploadSignature,
  uploadTemplate,
  uploadDocuments,
  uploadSingle,
  uploadGovernmentID,
  uploadKRACertificate,
  uploadBusinessRegistration,
  uploadKycDocument,
  uploadProductImages,       // ✅ NEW

  // Filters
  avatarFilter,
  logoFilter,
  bannerFilter,
  signatureFilter,
  templateFilter,
  documentFilter,
  governmentIDFilter,
  kraCertificateFilter,
  businessRegistrationFilter,
  kycDocumentFilter,
  productImageFilter,        // ✅ NEW

  // Error handling
  handleMulterError,

  // Middleware
  requireSingleFile,
  requireFiles,

  // Utilities
  getExtensionFromMimeType,
  getAllowedExtensions,
  isFileTypeAllowed,
  getMaxFileSize,

  // Constants
  MIME_TYPES,
  ALLOWED_MIME_TYPES,
};