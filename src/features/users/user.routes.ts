// src/routes/user.routes.ts
import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { protect, requireAdmin, requireSuperAdmin } from '../../middlewares/auth.middleware';
import {
    uploadAvatar,
    handleMulterError,
    requireSingleFile
} from '../../middlewares/upload';
import {
    updateProfileSchema,
    changePasswordSchema,
    uploadAvatarSchema,
    updateProfileWithAvatarSchema,
    updateAdminProfileSchema,
    registerAdminUserSchema,
    registerUserSchema,
    userListQuerySchema,
    userIdSchema,
    firstLoginPasswordResetSchema, // ✅ NEW
    checkFirstLoginSchema, // ✅ NEW
} from './user.validator';
import {
    getMe,
    updateMe,
    changeMyPassword,
    uploadMyAvatar,
    removeMyAvatar,
    updateMeWithAvatar,
    getUserByIdHandler,
    updateUserByIdHandler,
    deleteUserHandler,
    listUsersHandler,
    getUserStatsHandler,
    createAdminUserHandler,
    registerUserHandler,
    firstLoginPasswordResetHandler, // ✅ NEW
    checkFirstLoginHandler, // ✅ NEW
} from './user.controller';

const router = Router();

// ============================================
// Public Routes (No Authentication)
// ============================================

// Register regular user (customer or seller)
router.post(
    '/register',
    validate(registerUserSchema),
    registerUserHandler
);

// ============================================
// ✅ First Login Routes (No Authentication)
// ============================================

/**
 * Reset password on first login
 * POST /api/users/first-login/reset-password
 */
router.post(
    '/first-login/reset-password',
    validate(firstLoginPasswordResetSchema),
    firstLoginPasswordResetHandler
);

// ============================================
// Protected Routes (require authentication)
// ============================================

// Profile routes
router.get('/me', protect, getMe);
router.patch('/me', protect, validate(updateProfileSchema), updateMe);

// Password change
router.patch('/me/password', protect, validate(changePasswordSchema), changeMyPassword);

// Avatar routes
router.post(
    '/me/avatar',
    protect,
    uploadAvatar,
    handleMulterError,
    requireSingleFile('avatar'),
    validate(uploadAvatarSchema),
    uploadMyAvatar
);

router.delete('/me/avatar', protect, removeMyAvatar);

// Combined profile + avatar update
router.patch(
    '/me/with-avatar',
    protect,
    uploadAvatar,
    handleMulterError,
    validate(updateProfileWithAvatarSchema),
    updateMeWithAvatar
);

// ============================================
// ✅ First Login Check (Protected)
// ============================================

/**
 * Check if user needs password reset on first login
 * GET /api/users/first-login/check/:userId
 */
router.get(
    '/first-login/check/:userId',
    protect,
    validate(checkFirstLoginSchema),
    checkFirstLoginHandler
);

// ============================================
// Super Admin Routes (require super_admin only)
// ============================================

/**
 * Create admin user (moderator, admin, super_admin)
 * POST /api/users/admin/register
 */
router.post(
    '/admin/register',
    protect,
    requireSuperAdmin,
    validate(registerAdminUserSchema),
    createAdminUserHandler
);

// ============================================
// Admin Routes (require admin or super_admin)
// ============================================

/**
 * Get user by ID
 * GET /api/users/admin/users/:userId
 */
router.get(
    '/admin/users/:userId',
    protect,
    requireAdmin,
    validate(userIdSchema),
    getUserByIdHandler
);

/**
 * Update user (including role)
 * PUT /api/users/admin/users/:userId
 */
router.put(
    '/admin/users/:userId',
    protect,
    requireAdmin,
    validate(updateAdminProfileSchema),
    updateUserByIdHandler
);

/**
 * Delete user
 * DELETE /api/users/admin/users/:userId
 */
router.delete(
    '/admin/users/:userId',
    protect,
    requireAdmin,
    validate(userIdSchema),
    deleteUserHandler
);

/**
 * List all users (with pagination and filters)
 * GET /api/users/admin/users
 */
router.get(
    '/admin/users',
    protect,
    requireAdmin,
    validate(userListQuerySchema),
    listUsersHandler
);

/**
 * Get user statistics
 * GET /api/users/admin/stats
 */
router.get(
    '/admin/stats',
    protect,
    requireAdmin,
    getUserStatsHandler
);

// ============================================
// Legacy Admin Routes (deprecated - use /admin/*)
// ============================================

// @deprecated - Use /admin/users/:userId instead
router.get(
    '/:id',
    protect,
    requireAdmin,
    getUserByIdHandler
);

// @deprecated - Use /admin/users/:userId instead
router.patch(
    '/:id',
    protect,
    requireAdmin,
    validate(updateProfileSchema),
    updateUserByIdHandler
);

// @deprecated - Use /admin/users/:userId instead
router.delete(
    '/:id',
    protect,
    requireAdmin,
    deleteUserHandler
);

export default router;