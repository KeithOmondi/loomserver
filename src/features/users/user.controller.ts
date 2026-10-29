// src/controllers/user.controller.ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import {
    getUserById,
    updateUser,
    changeUserPassword,
    uploadUserAvatar,
    removeUserAvatar,
    updateUserWithAvatar,
    getUserProfile,
    deleteUser,
    updateUserByAdmin,
    listUsers,
    getUserStatistics,
    createUser,
    createAdminUser,
    firstLoginPasswordReset,
    checkFirstLogin,
} from './user.service';
import { UpdateUserInput, UpdatePasswordInput, CreateAdminUserInput } from './user.types';
import { sendAdminWelcomeEmail } from '../../utils/emailTemplates';
import { revokeAllUserTokens } from '../../services/token.service';
import { sendOTP } from '../auth/auth.service';

const COOKIE_PATH = '/api/v1/auth';

// ============================================
// Helper: Extract ID from Params
// ============================================

const extractId = (param: string | string[] | undefined): string => {
    if (!param) {
        throw new AppError(400, 'ID is required');
    }
    if (Array.isArray(param)) {
        return param[0];
    }
    return param;
};

// ============================================
// Profile Routes
// ============================================

export const getMe = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    const user = await getUserProfile(req.user.id);
    if (!user) throw new AppError(404, 'User not found.');

    res.status(200).json({ success: true, user });
});

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    const input: UpdateUserInput = req.body;
    const user = await updateUser(req.user.id, input);

    res.status(200).json({
        success: true,
        message: 'Profile updated successfully.',
        user,
    });
});

// ============================================
// Admin User Creation Routes
// ============================================

/**
 * Create admin user (moderator, admin, or super_admin)
 * POST /api/users/admin/register
 * ✅ Only super_admin can create admin users
 * ✅ User is active by default, receives welcome email with password
 */
export const createAdminUserHandler = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    // Only super_admin can create admin users
    if (req.user.role !== 'super_admin') {
        throw new AppError(403, 'Only super administrators can create admin users.');
    }

    const input: CreateAdminUserInput = req.body;
    const user = await createAdminUser(input);

    // ✅ Send welcome email with temporary password (NO OTP)
    await sendAdminWelcomeEmail({
        name: user.full_name, // ✅ Use 'name' not 'full_name'
        email: user.email,
        role: user.role,
        password: input.password,
        loginUrl: `${process.env.CLIENT_URL}/login`,
        appName: process.env.APP_NAME || 'Marketplace',
    });

    res.status(201).json({
        success: true,
        message: `${user.role} account created successfully. They will receive an email with their temporary password.`,
        data: {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            role: user.role,
            is_active: user.is_active,
            requiresPasswordReset: true,
        },
    });
});

// ============================================
// ✅ First Login Password Reset
// ============================================

/**
 * Reset password on first login
 * POST /api/users/first-login/reset-password
 */
export const firstLoginPasswordResetHandler = asyncHandler(async (req: Request, res: Response) => {
    const { email, temporary_password, new_password, confirm_password } = req.body;

    // ✅ Validate passwords match
    if (new_password !== confirm_password) {
        throw new AppError(400, 'Passwords do not match.');
    }

    const result = await firstLoginPasswordReset({
        email,
        temporaryPassword: temporary_password,
        newPassword: new_password,
        confirmPassword: confirm_password, // ✅ Added
    });

    res.status(200).json({
        success: true,
        message: result.message,
    });
});

/**
 * Check if user needs password reset on first login
 * GET /api/users/first-login/check/:userId
 */
export const checkFirstLoginHandler = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    const userId = extractId(req.params.userId);

    // Users can only check their own status, or admins can check anyone
    if (req.user.id !== userId && req.user.role !== 'admin' && req.user.role !== 'super_admin') {
        throw new AppError(403, 'You can only check your own first login status.');
    }

    const result = await checkFirstLogin(userId);

    res.status(200).json({
        success: true,
        data: result.data,
    });
});

// ============================================
// Password Routes
// ============================================

export const changeMyPassword = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    const { current_password, new_password } = req.body;

    const input: UpdatePasswordInput = {
        currentPassword: current_password,
        newPassword: new_password,
    };

    const result = await changeUserPassword(req.user.id, input);

    await revokeAllUserTokens(req.user.id);
    res.clearCookie('refreshToken', { path: COOKIE_PATH });

    res.status(200).json({
        success: true,
        message: result.message + ' Please log in again.',
    });
});

// ============================================
// Avatar Routes
// ============================================

export const uploadMyAvatar = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    if (!req.file) {
        throw new AppError(400, 'Avatar file is required.');
    }

    const result = await uploadUserAvatar(req.user.id, {
        file: req.file,
        userId: req.user.id,
    });

    res.status(200).json({
        success: true,
        message: 'Avatar uploaded successfully.',
        data: {
            url: result.url,
            publicId: result.publicId,
            format: result.format,
            width: result.width,
            height: result.height,
        },
    });
});

export const removeMyAvatar = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    const result = await removeUserAvatar(req.user.id);

    res.status(200).json({
        success: true,
        message: result.message,
    });
});

export const updateMeWithAvatar = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    const input = {
        full_name: req.body.full_name,
        email: req.body.email,
        avatar_file: req.file,
        remove_avatar: req.body.remove_avatar === 'true',
    };

    const updatedUser = await updateUserWithAvatar(req.user.id, input);

    res.status(200).json({
        success: true,
        message: 'Profile updated successfully.',
        user: updatedUser,
    });
});

// ============================================
// Admin Routes
// ============================================

/**
 * Get user by ID (Admin only)
 * GET /api/users/admin/:userId
 */
export const getUserByIdHandler = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
        throw new AppError(403, 'Admin access required.');
    }

    const id = extractId(req.params.id);

    const user = await getUserById(id);

    if (!user) {
        throw new AppError(404, 'User not found.');
    }

    res.status(200).json({ success: true, user });
});

/**
 * Update user by ID (Admin only)
 * PUT /api/users/admin/:userId
 */
export const updateUserByIdHandler = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
        throw new AppError(403, 'Admin access required.');
    }

    const id = extractId(req.params.id);

    // Prevent self-role modification
    if (id === req.user.id && req.body.role) {
        throw new AppError(400, 'Cannot change your own role.');
    }

    const { full_name, email, role, is_active } = req.body;

    const user = await updateUserByAdmin(id, {
        full_name,
        email,
        role,
        is_active,
    });

    res.status(200).json({
        success: true,
        message: 'User updated successfully.',
        user,
    });
});

/**
 * Delete user by ID (Admin only)
 * DELETE /api/users/admin/:userId
 */
export const deleteUserHandler = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
        throw new AppError(403, 'Admin access required.');
    }

    const id = extractId(req.params.id);

    // Prevent self-deletion
    if (id === req.user.id) {
        throw new AppError(400, 'Cannot delete your own account.');
    }

    // Check if user exists
    const user = await getUserById(id);
    if (!user) {
        throw new AppError(404, 'User not found.');
    }

    await deleteUser(id);

    res.status(200).json({
        success: true,
        message: 'User deleted successfully.',
    });
});

/**
 * List all users (Admin only)
 * GET /api/users/admin/users
 */
export const listUsersHandler = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
        throw new AppError(403, 'Admin access required.');
    }

    const {
        page = 1,
        limit = 20,
        role,
        search,
        is_active,
        sortBy = 'created_at',
        sortOrder = 'desc',
    } = req.query;

    const result = await listUsers({
        page: Number(page),
        limit: Number(limit),
        role: role as any,
        search: search as string,
        is_active: is_active ? is_active === 'true' : undefined,
        sortBy: sortBy as any,
        sortOrder: sortOrder as any,
    });

    res.status(200).json({
        success: true,
        data: result.users,
        pagination: result.pagination,
    });
});

/**
 * Get user statistics (Admin only)
 * GET /api/users/admin/stats
 */
export const getUserStatsHandler = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
        throw new AppError(403, 'Admin access required.');
    }

    const stats = await getUserStatistics();

    res.status(200).json({
        success: true,
        data: stats,
    });
});

// ============================================
// User Registration (Customer/Seller)
// ============================================

/**
 * Register a regular user (customer or seller)
 * POST /api/users/register
 */
export const registerUserHandler = asyncHandler(async (req: Request, res: Response) => {
    const { email, password, full_name, phone, role = 'customer' } = req.body;

    const user = await createUser({
        email,
        password,
        full_name,
        role,
        phone,
        is_active: false, // Requires OTP verification
    });

    // Send OTP for email verification
    await sendOTP(user.email);

    res.status(201).json({
        success: true,
        message: 'Account created successfully. An OTP has been sent to your email.',
        data: {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            role: user.role,
            is_active: user.is_active,
            requiresVerification: true,
        },
    });
});