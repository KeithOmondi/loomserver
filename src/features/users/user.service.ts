// src/services/user.service.ts
import bcrypt from 'bcryptjs';
import {
    User,
    AuthUser,
    SafeUser,
    UpdateUserInput,
    UpdatePasswordInput,
    UpdatePasswordResult,
    AvatarUploadInput,
    AvatarUploadResult,
    AvatarDeleteResult,
    UpdateUserWithAvatarInput,
    UserProfile,
    UserStatistics,
    UserListFilters,
    CreateUserInput,
    CreateAdminUserInput,
    AdminUpdateUserInput,
    FirstLoginPasswordResetInput,
    FirstLoginPasswordResetResult,
    FirstLoginCheckResponse,
} from './user.types';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import { env } from '../../config/env';
import {
    deleteFromCloudinary,
    uploadToCloudinary,
    mediaUrl,
} from '../../config/cloudinary';
import { redisService } from '../../config/redis';

// ============================================
// Helper Functions
// ============================================

const toSafeUser = (user: User): SafeUser => {
    const { password_hash, token_version, ...safe } = user;
    return safe;
};

const toAuthUser = (user: User): AuthUser => {
    const { password_hash, ...authUser } = user;
    return authUser;
};

const isUniqueViolation = (error: unknown): boolean => {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
};

// ============================================
// User Lookup Functions
// ============================================

export const findUserByEmail = async (email: string): Promise<User | null> => {
    const result = await pool.query<User>(`SELECT * FROM users WHERE email = $1`, [email]);
    return result.rows[0] ?? null;
};

export const findUserById = async (id: string): Promise<User | null> => {
    const result = await pool.query<User>(`SELECT * FROM users WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
};

export const getUserById = async (id: string): Promise<SafeUser | null> => {
    const user = await findUserById(id);
    return user ? toSafeUser(user) : null;
};

export const getUserByEmail = async (email: string): Promise<SafeUser | null> => {
    const user = await findUserByEmail(email);
    return user ? toSafeUser(user) : null;
};

// ============================================
// User Creation Functions
// ============================================

/**
 * Create a regular user (customer or seller)
 * is_active defaults to false (requires OTP verification)
 */
export const createUser = async (input: CreateUserInput): Promise<AuthUser> => {
    const { email, password, full_name, role, phone, is_active = false } = input;

    const password_hash = await bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS);

    try {
        const result = await pool.query<User>(
            `INSERT INTO users (
                email, password_hash, full_name, role, store_id, is_active, phone, token_version
            ) VALUES ($1, $2, $3, $4, NULL, $5, $6, 1)
            RETURNING *`,
            [email, password_hash, full_name, role, is_active, phone || null]
        );

        return toAuthUser(result.rows[0]);
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new AppError(409, 'An account with this email already exists.');
        }
        throw error;
    }
};

/**
 * Create an admin user (moderator, admin, or super_admin)
 * ✅ is_active defaults to true (no OTP verification needed)
 */
export const createAdminUser = async (input: CreateAdminUserInput): Promise<AuthUser> => {
    const { email, password, full_name, role, phone, is_active = true } = input;

    const password_hash = await bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS);

    try {
        const result = await pool.query<User>(
            `INSERT INTO users (
                email, password_hash, full_name, role, store_id, is_active, phone, token_version
            ) VALUES ($1, $2, $3, $4, NULL, $5, $6, 1)
            RETURNING *`,
            [email, password_hash, full_name, role, is_active, phone || null]
        );

        return toAuthUser(result.rows[0]);
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new AppError(409, 'An account with this email already exists.');
        }
        throw error;
    }
};

// ============================================
// First Login Password Reset
// ============================================

export const firstLoginPasswordReset = async (
    input: FirstLoginPasswordResetInput
): Promise<FirstLoginPasswordResetResult> => {
    const { email, temporaryPassword, newPassword } = input;

    const user = await findUserByEmail(email);
    if (!user) {
        throw new AppError(404, 'User not found.');
    }

    const isValid = await bcrypt.compare(temporaryPassword, user.password_hash);
    if (!isValid) {
        throw new AppError(401, 'Invalid temporary password.');
    }

    const newPasswordHash = await bcrypt.hash(newPassword, env.BCRYPT_SALT_ROUNDS);

    await pool.query(
        `UPDATE users
         SET password_hash = $1,
             token_version = token_version + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [newPasswordHash, user.id]
    );

    return {
        success: true,
        message: 'Password reset successfully. Please log in with your new password.',
    };
};

export const checkFirstLogin = async (userId: string): Promise<FirstLoginCheckResponse> => {
    const user = await findUserById(userId);
    if (!user) {
        throw new AppError(404, 'User not found.');
    }

    const isAdminCreated = ['moderator', 'support', 'finance', 'admin', 'super_admin'].includes(user.role);
    const needsPasswordReset = isAdminCreated && user.is_active;

    return {
        success: true,
        data: {
            isFirstLogin: needsPasswordReset,
            needsPasswordReset,
        },
    };
};

// ============================================
// Password Functions
// ============================================

export const verifyPassword = async (plain: string, hash: string): Promise<boolean> => {
    return bcrypt.compare(plain, hash);
};

export const hashPassword = async (password: string): Promise<string> => {
    return bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS);
};

export const updatePassword = async (id: string, newPassword: string): Promise<void> => {
    const password_hash = await bcrypt.hash(newPassword, env.BCRYPT_SALT_ROUNDS);
    await pool.query(
        `UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = now() WHERE id = $2`,
        [password_hash, id]
    );
};

export const incrementTokenVersion = async (id: string): Promise<void> => {
    await pool.query(
        `UPDATE users SET token_version = token_version + 1, updated_at = now() WHERE id = $1`,
        [id]
    );
};

export const changeUserPassword = async (
    userId: string,
    input: UpdatePasswordInput
): Promise<UpdatePasswordResult> => {
    const { currentPassword, newPassword } = input;

    const user = await findUserById(userId);
    if (!user) {
        throw new AppError(404, 'User not found.');
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isPasswordValid) {
        throw new AppError(401, 'Current password is incorrect.');
    }

    const isSamePassword = await bcrypt.compare(newPassword, user.password_hash);
    if (isSamePassword) {
        throw new AppError(400, 'New password must be different from the current password.');
    }

    await updatePassword(userId, newPassword);

    return {
        success: true,
        message: 'Password updated successfully.',
    };
};

// ============================================
// User Update Functions
// ============================================

export const updateUser = async (id: string, updates: UpdateUserInput): Promise<SafeUser> => {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (updates.full_name !== undefined) {
        fields.push(`full_name = $${i++}`);
        values.push(updates.full_name);
    }
    if (updates.email !== undefined) {
        fields.push(`email = $${i++}`);
        values.push(updates.email);
    }
    if (updates.avatar_url !== undefined) {
        fields.push(`avatar_url = $${i++}`);
        values.push(updates.avatar_url);
    }
    if (updates.avatar_public_id !== undefined) {
        fields.push(`avatar_public_id = $${i++}`);
        values.push(updates.avatar_public_id);
    }
    if (updates.phone !== undefined) {
        fields.push(`phone = $${i++}`);
        values.push(updates.phone);
    }

    if (fields.length === 0) {
        throw new AppError(400, 'No fields provided to update.');
    }

    fields.push(`updated_at = now()`);
    values.push(id);

    try {
        const result = await pool.query<User>(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
            values
        );

        if (!result.rows[0]) {
            throw new AppError(404, 'User not found.');
        }

        return toSafeUser(result.rows[0]);
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new AppError(409, 'This email is already in use by another account.');
        }
        throw error;
    }
};

export const updateUserByAdmin = async (
    id: string,
    updates: AdminUpdateUserInput
): Promise<SafeUser> => {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (updates.full_name !== undefined) {
        fields.push(`full_name = $${i++}`);
        values.push(updates.full_name);
    }
    if (updates.email !== undefined) {
        fields.push(`email = $${i++}`);
        values.push(updates.email);
    }
    if (updates.role !== undefined) {
        fields.push(`role = $${i++}`);
        values.push(updates.role);
    }
    if (updates.is_active !== undefined) {
        fields.push(`is_active = $${i++}`);
        values.push(updates.is_active);
    }

    if (fields.length === 0) {
        throw new AppError(400, 'No fields provided to update.');
    }

    fields.push(`updated_at = now()`);
    values.push(id);

    try {
        const result = await pool.query<User>(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
            values
        );

        if (!result.rows[0]) {
            throw new AppError(404, 'User not found.');
        }

        return toSafeUser(result.rows[0]);
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new AppError(409, 'This email is already in use by another account.');
        }
        throw error;
    }
};

// ============================================
// Avatar Functions
// ============================================

/**
 * Upload a new avatar for a user.
 *
 * Flow:
 *   1. Delete the old asset from Cloudinary (if any)
 *   2. Upload the new file → returns a normalized StoredAsset
 *   3. Build a public delivery URL via `mediaUrl`
 *   4. Persist url + public_id on the user row
 */
export const uploadUserAvatar = async (
    userId: string,
    input: AvatarUploadInput
): Promise<AvatarUploadResult> => {
    const { file } = input;

    const user = await findUserById(userId);
    if (!user) {
        throw new AppError(404, 'User not found.');
    }

    // Delete old asset (best-effort — don't fail the upload if this errors)
    if (user.avatar_public_id) {
        try {
            await deleteFromCloudinary(user.avatar_public_id);
        } catch (error) {
            console.error('Failed to delete old avatar:', error);
        }
    }

    // Upload the new file
    const uploadResult = await uploadToCloudinary(file, 'avatars');

    // Build a public URL from the normalized StoredAsset
    const avatarUrl = mediaUrl(
        {
            publicId: uploadResult.publicId,
            resourceType: uploadResult.resourceType,
            format: uploadResult.format,
        },
        'card',
    );

    // Persist url + public_id
    await updateUser(userId, {
        avatar_url: avatarUrl,
        avatar_public_id: uploadResult.publicId,
    });

    return {
        url: avatarUrl,
        publicId: uploadResult.publicId,
        format: uploadResult.format ?? 'unknown',
        width: uploadResult.width ?? 0,
        height: uploadResult.height ?? 0,
    };
};

export const removeUserAvatar = async (userId: string): Promise<AvatarDeleteResult> => {
    const user = await findUserById(userId);
    if (!user) {
        throw new AppError(404, 'User not found.');
    }

    if (user.avatar_public_id) {
        await deleteFromCloudinary(user.avatar_public_id);
    }

    await updateUser(userId, {
        avatar_url: null,
        avatar_public_id: null,
    });

    return {
        success: true,
        message: 'Avatar removed successfully.',
    };
};

export const updateUserWithAvatar = async (
    userId: string,
    input: UpdateUserWithAvatarInput
): Promise<SafeUser> => {
    const { full_name, email, avatar_file, remove_avatar } = input;

    const currentUser = await findUserById(userId);
    if (!currentUser) {
        throw new AppError(404, 'User not found.');
    }

    if (remove_avatar) {
        if (currentUser.avatar_public_id) {
            await deleteFromCloudinary(currentUser.avatar_public_id);
        }
        await updateUser(userId, {
            avatar_url: null,
            avatar_public_id: null,
        });
    } else if (avatar_file) {
        await uploadUserAvatar(userId, { file: avatar_file, userId });
    }

    const updates: UpdateUserInput = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (email !== undefined) updates.email = email;

    if (Object.keys(updates).length > 0) {
        return await updateUser(userId, updates);
    }

    return (await getUserById(userId)) as SafeUser;
};

// ============================================
// Profile Functions
// ============================================

export const getUserProfile = async (userId: string): Promise<SafeUser> => {
    const user = await getUserById(userId);
    if (!user) {
        throw new AppError(404, 'User not found.');
    }
    return user;
};

// ============================================
// User List Functions (Admin)
// ============================================

interface ExtendedUserListFilters extends UserListFilters {
    sortBy?: 'created_at' | 'full_name' | 'email' | 'role';
    sortOrder?: 'asc' | 'desc';
}

export const listUsers = async (filters: ExtendedUserListFilters) => {
    const {
        page = 1,
        limit = 20,
        role,
        search,
        is_active,
        sortBy = 'created_at',
        sortOrder = 'desc',
    } = filters;

    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramCount = 1;

    if (role) {
        conditions.push(`role = $${paramCount++}`);
        values.push(role);
    }

    if (is_active !== undefined) {
        conditions.push(`is_active = $${paramCount++}`);
        values.push(is_active);
    }

    if (search) {
        conditions.push(`(email ILIKE $${paramCount} OR full_name ILIKE $${paramCount})`);
        values.push(`%${search}%`);
        paramCount++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await pool.query(
        `SELECT COUNT(*) FROM users ${whereClause}`,
        values
    );
    const total = parseInt(countResult.rows[0].count);

    // Get users
    const result = await pool.query(
        `SELECT id, email, full_name, role, phone, is_active, avatar_url, created_at, updated_at
         FROM users
         ${whereClause}
         ORDER BY ${sortBy} ${sortOrder}
         LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
        [...values, limit, offset]
    );

    return {
        users: result.rows,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        },
    };
};

// ============================================
// User Statistics Functions (Admin)
// ============================================

export const getUserStatistics = async (): Promise<UserStatistics> => {
    const result = await pool.query(
        `SELECT
            COUNT(*) as total_users,
            SUM(CASE WHEN role = 'customer' THEN 1 ELSE 0 END) as customers,
            SUM(CASE WHEN role = 'seller' THEN 1 ELSE 0 END) as sellers,
            SUM(CASE WHEN role = 'moderator' THEN 1 ELSE 0 END) as moderators,
            SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admins,
            SUM(CASE WHEN role = 'super_admin' THEN 1 ELSE 0 END) as super_admins,
            SUM(CASE WHEN is_active = true THEN 1 ELSE 0 END) as active_users,
            SUM(CASE WHEN is_active = false THEN 1 ELSE 0 END) as inactive_users
        FROM users`
    );

    const row = result.rows[0];
    return {
        total_users: parseInt(row.total_users || '0'),
        customers: parseInt(row.customers || '0'),
        sellers: parseInt(row.sellers || '0'),
        moderators: parseInt(row.moderators || '0'),
        admins: parseInt(row.admins || '0'),
        super_admins: parseInt(row.super_admins || '0'),
        active_users: parseInt(row.active_users || '0'),
        inactive_users: parseInt(row.inactive_users || '0'),
    };
};

// ============================================
// User Delete Function
// ============================================

export const deleteUser = async (id: string): Promise<void> => {
    const user = await findUserById(id);
    if (!user) {
        throw new AppError(404, 'User not found.');
    }

    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);

    await redisService.cacheDelete(`user:${id}`);
    await redisService.cacheDelete(`profile:${id}`);
    await redisService.cacheDelete(`store:user:${id}`);
    await redisService.cacheDeletePattern(`session:*:${id}`);
};

// ============================================
// Batch User Functions
// ============================================

export const bulkDeleteUsers = async (ids: string[]): Promise<{ deleted: number; failed: string[] }> => {
    const failed: string[] = [];
    let deleted = 0;

    for (const id of ids) {
        try {
            await deleteUser(id);
            deleted++;
        } catch (error) {
            failed.push(id);
        }
    }

    return { deleted, failed };
};

export const bulkUpdateUserStatus = async (
    ids: string[],
    isActive: boolean
): Promise<{ updated: number; failed: string[] }> => {
    const failed: string[] = [];
    let updated = 0;

    for (const id of ids) {
        try {
            await pool.query(
                `UPDATE users SET is_active = $1, updated_at = now() WHERE id = $2`,
                [isActive, id]
            );
            updated++;
        } catch (error) {
            failed.push(id);
        }
    }

    return { updated, failed };
};

// ============================================
// Export All
// ============================================

export const userService = {
    // Lookup
    findUserByEmail,
    findUserById,
    getUserById,
    getUserByEmail,

    // Creation
    createUser,
    createAdminUser,

    // First Login
    firstLoginPasswordReset,
    checkFirstLogin,

    // Update
    updateUser,
    updateUserByAdmin,

    // Password
    verifyPassword,
    hashPassword,
    updatePassword,
    incrementTokenVersion,
    changeUserPassword,

    // Avatar
    uploadUserAvatar,
    removeUserAvatar,
    updateUserWithAvatar,

    // Profile
    getUserProfile,

    // Admin
    listUsers,
    getUserStatistics,
    deleteUser,
    bulkDeleteUsers,
    bulkUpdateUserStatus,
};