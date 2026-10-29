// src/config/cloudinary.ts
import {
  v2 as cloudinary,
  UploadApiResponse,
  UploadApiOptions,
} from "cloudinary";
import { env } from "./env";
import { Readable } from "stream";
import pLimit from "p-limit";

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Limit concurrent uploads to 10 to manage network congestion
const limit = pLimit(10);

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type ResourceType = "image" | "video" | "raw";

/**
 * What we persist in the DB. Callers never see the raw Cloudinary response,
 * so full URLs (secure_url) can't be stored by accident.
 *
 * Suggested columns: public_id, resource_type, format, bytes, width, height
 */
export interface StoredAsset {
  publicId: string; // includes folder, e.g. sellers/12/products/abc123
  resourceType: ResourceType;
  format: string | null; // 'jpg', 'pdf', 'docx', ...
  bytes: number;
  width: number | null;
  height: number | null;
}

const toStoredAsset = (r: UploadApiResponse): StoredAsset => ({
  publicId: r.public_id,
  resourceType: r.resource_type as ResourceType,
  format: r.format ?? null,
  bytes: r.bytes,
  width: r.width ?? null,
  height: r.height ?? null,
});

/* -------------------------------------------------------------------------- */
/*  Input validation                                                          */
/*                                                                            */
/*  Multer file uploads are validated (type + size) in                        */
/*  upload.middleware.ts, which is the single source of truth for that.       */
/*  Only the base64 string path needs checking here, since it bypasses Multer.*/
/* -------------------------------------------------------------------------- */

const MAX_DATA_URI_BYTES = 10 * 1024 * 1024; // 10 MB

// Image data URIs only (no remote URLs, so this can't be used to make
// Cloudinary fetch arbitrary content on our account).
const DATA_URI_RE =
  /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

const assertValidImageString = (input: string): void => {
  const match = DATA_URI_RE.exec(input);
  if (!match) {
    throw new Error(
      "Only base64 image data URIs (jpeg, png, webp, gif) are allowed",
    );
  }
  const approxBytes = Math.floor((match[2].length * 3) / 4);
  if (approxBytes > MAX_DATA_URI_BYTES) {
    throw new Error(
      `Image exceeds the ${MAX_DATA_URI_BYTES / 1024 / 1024}MB limit`,
    );
  }
};

// Keep folders predictable: letters, numbers, dash, underscore, slash only.
const sanitizeFolder = (folder: string): string =>
  folder
    .replace(/[^a-zA-Z0-9_\-/]/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/|\/$/g, "");

/* -------------------------------------------------------------------------- */
/*  Upload                                                                    */
/* -------------------------------------------------------------------------- */

const finish =
  (resolve: (a: StoredAsset) => void, reject: (e: unknown) => void) =>
  (error: unknown, result?: UploadApiResponse) => {
    if (error) {
      console.error("Cloudinary upload error:", error);
      return reject(error);
    }
    if (!result) {
      return reject(new Error("Upload failed: No result from Cloudinary"));
    }
    resolve(toStoredAsset(result));
  };

/**
 * Accepts a Multer file (already validated by upload.middleware.ts) or a
 * base64 image data URI. Pass seller-scoped folders, e.g.
 * `sellers/${sellerId}/products`.
 */
export const uploadToCloudinary = (
  file: Express.Multer.File | string,
  folder: string,
): Promise<StoredAsset> => {
  return new Promise((resolve, reject) => {
    const safeFolder = sanitizeFolder(folder);
    if (!safeFolder) {
      return reject(new Error("Upload folder is required"));
    }

    /* ------------------------- string (data URI) input ------------------------ */
    if (typeof file === "string") {
      try {
        assertValidImageString(file);
      } catch (err) {
        return reject(err);
      }

      const options: UploadApiOptions = {
        folder: safeFolder,
        access_mode: "public",
        resource_type: "image",
        transformation: [{ width: 1600, crop: "limit", quality: "auto" }],
      };

      cloudinary.uploader.upload(file, options, finish(resolve, reject));
      return;
    }

    /* ------------------------------ Multer input ------------------------------ */
    const isPdf = file.mimetype === "application/pdf";
    const isVideo = file.mimetype.startsWith("video/");
    const isImage = file.mimetype.startsWith("image/");

    // PDFs are uploaded as "image" so Cloudinary can render/transform them.
    // Video stays "video". Everything else (Word, Excel, archives, audio,
    // text...) is stored as "raw".
    let resourceType: ResourceType;
    if (isPdf || isImage) resourceType = "image";
    else if (isVideo) resourceType = "video";
    else resourceType = "raw";

    const options: UploadApiOptions = {
      folder: safeFolder,
      access_mode: "public",
      resource_type: resourceType,
    };

    if (isPdf) {
      options.format = "pdf";
    } else if (isVideo) {
      options.eager = [{ streaming_profile: "hd", quality: "auto" }];
      options.eager_async = true;
    } else if (isImage) {
      // Originals are stored at max 1600px wide (deliberate cost trade-off).
      options.transformation = [{ width: 1600, crop: "limit", quality: "auto" }];
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      options,
      finish(resolve, reject),
    );

    Readable.from(file.buffer).pipe(uploadStream);
  });
};

export const uploadMultipleToCloudinary = async (
  files: Express.Multer.File[],
  folder: string,
): Promise<StoredAsset[]> => {
  const uploadPromises = files.map((file) =>
    limit(() => uploadToCloudinary(file, folder)),
  );
  return Promise.all(uploadPromises);
};

/* -------------------------------------------------------------------------- */
/*  Delete                                                                    */
/* -------------------------------------------------------------------------- */

export const deleteFromCloudinary = (
  publicId: string,
  resourceType: ResourceType = "image",
): Promise<void> => {
  return cloudinary.uploader
    .destroy(publicId, { resource_type: resourceType, invalidate: true })
    .then(() => undefined);
};

/** Convenience: delete using the record you stored in the DB. */
export const deleteAsset = (
  asset: Pick<StoredAsset, "publicId" | "resourceType">,
): Promise<void> => deleteFromCloudinary(asset.publicId, asset.resourceType);

/* -------------------------------------------------------------------------- */
/*  URL builder (the ONLY place that knows about Cloudinary URL syntax)       */
/* -------------------------------------------------------------------------- */

// Change this (and PRESETS below) when you migrate to another provider.
const MEDIA_BASE_URL =
  process.env.MEDIA_BASE_URL ??
  `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}`;

export const PRESETS = {
  thumb: "w_200,h_200,c_fill,f_auto,q_auto",
  card: "w_480,h_480,c_fill,f_auto,q_auto",
  detail: "w_1200,c_limit,f_auto,q_auto",
} as const;

export type MediaPreset = keyof typeof PRESETS;

export const mediaUrl = (
  asset: {
    publicId: string;
    resourceType: string;
    format?: string | null;
  },
  preset?: MediaPreset,
): string => {
  const t = preset ? `${PRESETS[preset]}/` : "";

  if (asset.resourceType === "raw") {
    // raw public_ids already include the extension
    return `${MEDIA_BASE_URL}/raw/upload/${asset.publicId}`;
  }
  if (asset.resourceType === "video") {
    return `${MEDIA_BASE_URL}/video/upload/${t}${asset.publicId}.${asset.format ?? "mp4"}`;
  }
  // image (including PDFs uploaded as image)
  const ext = asset.format === "pdf" ? ".pdf" : "";
  return `${MEDIA_BASE_URL}/image/upload/${t}${asset.publicId}${ext}`;
};

export { cloudinary };