// src/middlewares/auth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import { pool } from '../config/db';
import { AppError } from '../utils/response';
import { StoreProfile } from '../features/store/store.types';

// ✅ Added 'moderator' role
export type UserRole = 'customer' | 'seller' | 'moderator' | 'admin' | 'super_admin';

// Updated: No store_id in token payload
const decodedTokenSchema = z.object({
    id: z.string().min(1),
    email: z.string().email(),
    full_name: z.string().min(1),
    role: z.enum(['customer', 'seller', 'moderator', 'admin', 'super_admin']),
    token_version: z.number().int().nonnegative(),
});

type DecodedToken = z.infer<typeof decodedTokenSchema>;

// Role hierarchy — higher number = more platform-level access.
const ROLE_RANK: Record<UserRole, number> = {
    customer: 0,
    seller: 1,
    moderator: 2,
    admin: 3,
    super_admin: 4,
};

const getCurrentTokenVersion = async (userId: string): Promise<number | null> => {
    const result = await pool.query<{ token_version: number }>(
        `SELECT token_version FROM users WHERE id = $1`,
        [userId]
    );
    return result.rows[0]?.token_version ?? null;
};

// ============================================
// Helper: Get Store by User ID
// ============================================

export const getStoreByUserId = async (userId: string): Promise<StoreProfile | null> => {
    const result = await pool.query(
        `SELECT st.* 
         FROM stores st
         JOIN sellers s ON s.id = st.seller_id
         WHERE s.user_id = $1 
           AND st.deleted_at IS NULL
         LIMIT 1`,
        [userId]
    );
    return result.rows[0] || null;
};

// ============================================
// Helper: Get All Stores by User ID
// ============================================

export const getStoresByUserId = async (userId: string): Promise<StoreProfile[]> => {
    const result = await pool.query(
        `SELECT st.* 
         FROM stores st
         JOIN sellers s ON s.id = st.seller_id
         WHERE s.user_id = $1 
           AND st.deleted_at IS NULL`,
        [userId]
    );
    return result.rows;
};

// ============================================
// Helper: Check if User Has Seller Profile
// ============================================

export const hasSellerProfile = async (userId: string): Promise<boolean> => {
    const result = await pool.query(
        `SELECT id FROM sellers WHERE user_id = $1`,
        [userId]
    );
    return result.rows.length > 0;
};

// ============================================
// Helper: Get Seller ID by User ID
// ============================================

export const getSellerIdByUserId = async (userId: string): Promise<string | null> => {
    const result = await pool.query(
        `SELECT id FROM sellers WHERE user_id = $1`,
        [userId]
    );
    return result.rows[0]?.id || null;
};

// ============================================
// Core Auth Middleware
// ============================================

export const protect = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;


    if (!authHeader?.startsWith('Bearer ')) {
        return next(new AppError(401, 'Access denied. No token provided.'));
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
        return next(new AppError(401, 'Access denied. No token provided.'));
    }


    let rawDecoded: unknown;
    try {
        rawDecoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (error) {
        console.error('❌ [protect] Token verification failed:', error);
        if (error instanceof jwt.TokenExpiredError) {
            return next(new AppError(401, 'Session expired. Please log in again.'));
        }
        if (error instanceof jwt.JsonWebTokenError) {
            return next(new AppError(401, 'Authentication failed. Invalid token.'));
        }
        return next(new AppError(401, 'Authentication failed.'));
    }

    const parsed = decodedTokenSchema.safeParse(rawDecoded);
    if (!parsed.success) {
        console.error('❌ [protect] Token payload validation failed:', parsed.error);
        return next(new AppError(401, 'Authentication failed. Malformed token payload.'));
    }

    const decoded: DecodedToken = parsed.data;

    const currentVersion = await getCurrentTokenVersion(decoded.id);

    if (currentVersion === null) {
        return next(new AppError(401, 'Account no longer exists.'));
    }

    if (decoded.token_version !== currentVersion) {
        return next(new AppError(401, 'Session invalidated. Please log in again.'));
    }

    // Set user on request (no store_id)
    req.user = {
        id: decoded.id,
        email: decoded.email,
        full_name: decoded.full_name,
        role: decoded.role,
        token_version: decoded.token_version,
    };

    next();
};

// ============================================
// Role-Based Middleware
// ============================================

export const requireRole = (...allowedRoles: UserRole[]) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            return next(new AppError(401, 'Authentication required.'));
        }

        const userRole = req.user.role as UserRole;

        if (!(userRole in ROLE_RANK)) {
            return next(new AppError(403, 'Unrecognised role. Access denied.'));
        }

        if (allowedRoles.includes(userRole)) return next();

        const minRank = Math.min(...allowedRoles.map(role => ROLE_RANK[role]));
        if (ROLE_RANK[userRole] >= minRank) return next();

        const roleNames = allowedRoles.join(' or ');
        return next(new AppError(403, `This action requires ${roleNames} privileges or above.`));
    };
};

// ============================================
// Moderator Middleware
// ============================================

/**
 * requireModerator - Gates moderation actions (approving stores,
 * reviewing products, managing content).
 *
 * ✅ Allows: moderator, admin, super_admin
 * ❌ Denies: customer, seller
 */
export const requireModerator = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
        return next(new AppError(401, 'Authentication required.'));
    }

    const allowedRoles: UserRole[] = ['moderator', 'admin', 'super_admin'];

    if (!allowedRoles.includes(req.user.role)) {
        return next(new AppError(403, 'Restricted to moderators and administrators.'));
    }

    next();
};

/**
 * requireModeratorOrAdmin - Same as requireModerator (alias for clarity)
 */
export const requireModeratorOrAdmin = requireModerator;

// ============================================
// Store Ownership Middleware
// ============================================

export const requireStoreOwnership = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
        return next(new AppError(401, 'Authentication required.'));
    }

    // Admins and moderators have access to all stores
    if (req.user.role === 'admin' || req.user.role === 'super_admin' || req.user.role === 'moderator') {
        return next();
    }

    if (req.user.role !== 'seller') {
        return next(new AppError(403, 'Only sellers can manage store resources.'));
    }

    const targetStoreId = req.params.storeId || req.params.id || req.body.store_id || req.resourceStoreId;

    if (!targetStoreId) {
        return next(new AppError(400, 'Store context could not be resolved for this request.'));
    }

    // Check if the user owns this store
    const result = await pool.query(
        `SELECT st.id 
         FROM stores st
         JOIN sellers s ON s.id = st.seller_id
         WHERE st.id = $1 AND s.user_id = $2 AND st.deleted_at IS NULL`,
        [targetStoreId, req.user.id]
    );

    if (result.rows.length === 0) {
        return next(new AppError(403, 'You do not have access to this store.'));
    }

    // Attach the store to the request for downstream use
    req.resourceStoreId = targetStoreId;

    next();
};

// ============================================
// Seller Verification Middleware
// ============================================

/**
 * requireVerifiedSeller - gates store-facing actions (listing products,
 * requesting payouts) behind a completed onboarding flow.
 *
 * ✅ Checks if seller profile exists
 * ✅ Checks if store exists
 * ✅ Checks if store is ACTIVE
 *
 * NOTE: Stores no longer require admin approval. Once the seller is
 * verified and the store is active, it's live.
 */
export const requireVerifiedSeller = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
        return next(new AppError(401, 'Authentication required.'));
    }

    // 1. Check if user is a seller
    if (req.user.role !== 'seller') {
        return next(new AppError(403, 'Restricted to sellers.'));
    }

    // 2. Check if user has a seller profile
    const hasProfile = await hasSellerProfile(req.user.id);
    if (!hasProfile) {
        return next(new AppError(403, 'Please complete your seller profile first.'));
    }

    // 3. Check if user has a store
    const store = await getStoreByUserId(req.user.id);

    if (!store) {
        return next(new AppError(403, 'Please create a store first.'));
    }

    // 4. Check store is active
    if (!store.is_active) {
        return next(new AppError(403, 'Your store is currently inactive. Please contact support.'));
    }

    // 5. Store is active — attach to request for downstream use
    req.store = store;
    req.resourceStoreId = store.id;

    next();
};

// ============================================
// Require Seller Profile (Not Store)
// ============================================

export const requireSellerProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
        return next(new AppError(401, 'Authentication required.'));
    }

    if (req.user.role !== 'seller') {
        return next(new AppError(403, 'Restricted to sellers.'));
    }

    const hasProfile = await hasSellerProfile(req.user.id);
    if (!hasProfile) {
        return next(new AppError(403, 'Please complete your seller profile first.'));
    }

    next();
};

// ============================================
// Admin Middleware
// ============================================

export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
        return next(new AppError(401, 'Authentication required.'));
    }

    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
        return next(new AppError(403, 'Restricted to administrators.'));
    }

    next();
};

export const requireSuperAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
        return next(new AppError(401, 'Authentication required.'));
    }

    if (req.user.role !== 'super_admin') {
        return next(new AppError(403, 'Restricted to superadministrators only.'));
    }

    next();
};

// ============================================
// Combined Middleware Helpers
// ============================================

/**
 * requireSellerOrModerator - Allows both sellers (for their own data)
 * and moderators (for reviewing)
 */
export const requireSellerOrModerator = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
        return next(new AppError(401, 'Authentication required.'));
    }

    if (req.user.role === 'seller' || req.user.role === 'moderator' ||
        req.user.role === 'admin' || req.user.role === 'super_admin') {
        return next();
    }

    return next(new AppError(403, 'Restricted to sellers and moderators.'));
};


// ============================================
// Optional Authentication
// ============================================

/**
 * Like `protect`, but does NOT reject when the Authorization header is
 * missing or invalid.
 *
 * - Valid Bearer token → populates `req.user`
 * - No token / invalid token → continues with `req.user` undefined
 *
 * Use for endpoints that serve both authenticated users and guests —
 * e.g., the cart (guests can add to cart before logging in).
 */
export const protectOptional = async (
    req: Request,
    _res: Response,
    next: NextFunction,
): Promise<void> => {
    const authHeader = req.headers.authorization;

    // No Bearer token → guest request; continue without req.user
    if (!authHeader?.startsWith('Bearer ')) {
        return next();
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return next();
    }

    let rawDecoded: unknown;
    try {
        rawDecoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        // Invalid/expired token → treat as guest rather than failing
        return next();
    }

    const parsed = decodedTokenSchema.safeParse(rawDecoded);
    if (!parsed.success) {
        return next();
    }

    const decoded: DecodedToken = parsed.data;

    // Verify token version against DB (same check as `protect`)
    const currentVersion = await getCurrentTokenVersion(decoded.id);
    if (currentVersion === null || decoded.token_version !== currentVersion) {
        // Stale token → treat as guest
        return next();
    }

    // Attach user to request
    req.user = {
        id: decoded.id,
        email: decoded.email,
        full_name: decoded.full_name,
        role: decoded.role,
        token_version: decoded.token_version,
    };

    next();
};