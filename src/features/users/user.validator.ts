// src/validators/user.validator.ts
import { z } from 'zod';

// ============================================
// Password Validation
// ============================================

const passwordField = z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password must be at most 72 characters')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number');

// ============================================
// Common Validation Helpers
// ============================================

const emailField = z
    .string()
    .email('Enter a valid email address')
    .max(254, 'Email is too long')
    .toLowerCase()
    .trim();

const fullNameField = z
    .string()
    .min(2, 'Full name must be at least 2 characters')
    .max(100, 'Full name is too long')
    .trim();

const phoneField = z
    .string()
    .min(10, 'Phone number must be at least 10 characters')
    .max(20, 'Phone number is too long')
    .regex(/^\+?[0-9\s\-()]+$/, 'Invalid phone number format')
    .optional()
    .nullable();

const urlField = z
    .string()
    .url('Invalid URL')
    .max(500, 'URL is too long')
    .optional()
    .nullable();

// ============================================
// User Registration Schemas
// ============================================

/**
 * Customer Registration Schema
 */
export const registerUserSchema = z.object({
    body: z.object({
        email: emailField,
        password: passwordField,
        full_name: fullNameField,
        phone: phoneField,
        role: z.enum(['customer', 'seller']).default('customer'),
    }),
});

/**
 * Admin User Registration Schema (for creating moderators/admins)
 */
export const registerAdminUserSchema = z.object({
    body: z.object({
        email: emailField,
        password: passwordField,
        full_name: fullNameField,
        phone: phoneField,
        role: z.enum(['moderator', 'support', 'finance', 'admin', 'super_admin']),
        // ✅ NEW: Option to send welcome email with password
        send_welcome_email: z.boolean().optional().default(true),
    }),
});

// ============================================
// ✅ NEW: First Login Password Reset Schema
// ============================================

/**
 * First Login Password Reset Schema
 * Used when a user logs in with a temporary password
 */
export const firstLoginPasswordResetSchema = z
    .object({
        body: z.object({
            email: emailField,
            temporary_password: z.string().min(1, 'Temporary password is required'),
            new_password: passwordField,
            confirm_password: z.string().min(1, 'Please confirm your password'),
        }),
    })
    .superRefine((data, ctx) => {
        if (data.body.new_password !== data.body.confirm_password) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Passwords don't match",
                path: ['body', 'confirm_password'],
            });
        }
        if (data.body.new_password === data.body.temporary_password) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'New password must be different from the temporary password',
                path: ['body', 'new_password'],
            });
        }
    });

// ============================================
// ✅ NEW: Check First Login Schema
// ============================================

export const checkFirstLoginSchema = z.object({
    params: z.object({
        userId: z.string().uuid('Invalid user ID format'),
    }),
});

// ============================================
// User Profile Update Schemas
// ============================================

/**
 * Update User Profile Schema
 */
export const updateProfileSchema = z.object({
    body: z.object({
        full_name: fullNameField.optional(),
        email: emailField.optional(),
        phone: phoneField,
        avatar_url: urlField,
        avatar_public_id: urlField,
    }),
});

/**
 * Admin Update User Profile Schema
 */
export const updateAdminProfileSchema = z.object({
    body: z.object({
        full_name: fullNameField.optional(),
        email: emailField.optional(),
        phone: phoneField,
        role: z.enum(['moderator', 'support', 'finance', 'admin', 'super_admin']).optional(),
        is_active: z.boolean().optional(),
    }),
});

// ============================================
// Password Change Schemas
// ============================================

export const changePasswordSchema = z
    .object({
        body: z.object({
            current_password: z.string().min(1, 'Current password is required'),
            new_password: passwordField,
            confirm_password: z.string().min(1, 'Please confirm your password'),
        }),
    })
    .superRefine((data, ctx) => {
        if (data.body.new_password !== data.body.confirm_password) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Passwords don't match",
                path: ['body', 'confirm_password'],
            });
        }
    });

// ============================================
// Avatar Schemas
// ============================================

export const uploadAvatarSchema = z.object({
    file: z.any().refine(
        (file) => {
            if (!file) return false;
            return file.mimetype && file.size && file.size > 0;
        },
        { message: 'Avatar file is required' }
    ),
});

export const updateProfileWithAvatarSchema = z
    .object({
        body: z.object({
            full_name: fullNameField.optional(),
            email: emailField.optional(),
            phone: phoneField,
            remove_avatar: z.enum(['true', 'false']).optional().transform((val) => val === 'true'),
        }),
        file: z.any().optional(),
    })
    .superRefine((data, ctx) => {
        const hasFile = data.file && data.file.size && data.file.size > 0;
        const wantsRemove = data.body.remove_avatar === true;

        if (!hasFile && !wantsRemove) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Either upload an avatar or specify remove_avatar=true',
                path: ['file'],
            });
        }
    });

// ============================================
// Admin User List Schemas
// ============================================

export const userListQuerySchema = z.object({
    query: z.object({
        page: z.coerce.number().min(1, 'Page must be at least 1').optional().default(1),
        limit: z.coerce.number().min(1, 'Limit must be at least 1').max(100, 'Limit must be at most 100').optional().default(20),
        role: z.enum(['customer', 'seller', 'moderator', 'support', 'finance', 'admin', 'super_admin']).optional(),
        search: z.string().max(100, 'Search term is too long').trim().optional(),
        is_active: z.coerce.boolean().optional(),
        sortBy: z.enum(['created_at', 'full_name', 'email', 'role']).optional().default('created_at'),
        sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
    }),
});

// ============================================
// User ID Schema
// ============================================

export const userIdSchema = z.object({
    params: z.object({
        userId: z.string().uuid('Invalid user ID format'),
    }),
});

// ============================================
// Avatar Validation Rules
// ============================================

export const AVATAR_VALIDATION = {
    MAX_SIZE: 5 * 1024 * 1024, // 5MB
    ALLOWED_MIME_TYPES: [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/svg+xml',
    ],
    ALLOWED_EXTENSIONS: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'],
    MIN_WIDTH: 100,
    MIN_HEIGHT: 100,
    MAX_WIDTH: 2000,
    MAX_HEIGHT: 2000,
} as const;

// ============================================
// Type Inference
// ============================================

// Registration
export type RegisterUserInput = z.infer<typeof registerUserSchema>['body'];
export type RegisterAdminUserInput = z.infer<typeof registerAdminUserSchema>['body'];

// First Login
export type FirstLoginPasswordResetInput = z.infer<typeof firstLoginPasswordResetSchema>['body'];
export type CheckFirstLoginInput = z.infer<typeof checkFirstLoginSchema>['params'];

// Profile
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>['body'];
export type UpdateAdminProfileInput = z.infer<typeof updateAdminProfileSchema>['body'];

// Password
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>['body'];

// Avatar
export type UploadAvatarInput = {
    file: Express.Multer.File;
};
export type UpdateProfileWithAvatarInput = {
    body: z.infer<typeof updateProfileWithAvatarSchema>['body'];
    file?: Express.Multer.File;
};

// Admin
export type UserListQueryInput = z.infer<typeof userListQuerySchema>['query'];
export type UserIdInput = z.infer<typeof userIdSchema>['params'];

// ============================================
// Export All Schemas
// ============================================

export const userSchemas = {
    registerUser: registerUserSchema,
    registerAdminUser: registerAdminUserSchema,
    firstLoginPasswordReset: firstLoginPasswordResetSchema,
    checkFirstLogin: checkFirstLoginSchema,
    updateProfile: updateProfileSchema,
    updateAdminProfile: updateAdminProfileSchema,
    changePassword: changePasswordSchema,
    uploadAvatar: uploadAvatarSchema,
    updateProfileWithAvatar: updateProfileWithAvatarSchema,
    userListQuery: userListQuerySchema,
    userId: userIdSchema,
};

export default userSchemas;