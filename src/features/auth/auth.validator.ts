// src/validators/auth.validator.ts
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

const resetPasswordField = passwordField;

// ============================================
// Common Validation Helpers
// ============================================

const emailField = z
    .string()
    .email('Enter a valid email address')
    .max(254, 'Email is too long')
    .toLowerCase()
    .trim();

const phoneField = z
    .string()
    .min(10, 'Phone number is required')
    .max(20, 'Phone number is too long')
    .regex(/^\+?[0-9\s\-()]+$/, 'Invalid phone number format')
    .optional(); // ✅ Made optional for customer registration

const fullNameField = z
    .string()
    .min(2, 'Full name is required')
    .max(100, 'Full name is too long')
    .trim();

// ============================================
// Registration Schemas
// ============================================

/**
 * Customer Registration Schema
 */
export const registerSchema = z.object({
    body: z.object({
        email: emailField,
        password: passwordField,
        full_name: fullNameField,
        phone: phoneField,
        role: z.enum(['customer', 'seller']).optional().default('customer'),
    }),
});

/**
 * Seller Registration Schema
 */
export const sellerRegisterSchema = z.object({
    body: z.object({
        email: emailField,
        password: passwordField,
        full_name: fullNameField,
        phone: z.string()
            .min(10, 'Phone number is required')
            .max(20, 'Phone number is too long')
            .regex(/^\+?[0-9\s\-()]+$/, 'Invalid phone number format'),
        role: z.literal('seller'),
    }),
});

/**
 * Admin Registration Schema (for creating moderator/admin/super_admin)
 * ✅ Only accessible to super_admin
 */
export const adminRegisterSchema = z.object({
    body: z.object({
        email: emailField,
        password: passwordField,
        full_name: fullNameField,
        phone: phoneField,
        role: z.enum(['moderator', 'admin', 'super_admin']),
        send_welcome_email: z.boolean().optional().default(true), // ✅ NEW
    }),
});

// ============================================
// Login Schema
// ============================================

export const loginSchema = z.object({
    body: z.object({
        email: emailField,
        password: z.string().min(1, 'Password is required').max(72, 'Password must be at most 72 characters'),
    }),
});

// ============================================
// OTP Schemas
// ============================================

export const verifyOTPSchema = z.object({
    body: z.object({
        email: emailField,
        otp: z.string().length(6, 'OTP must be exactly 6 digits').regex(/^\d+$/, 'OTP must contain only numbers'),
    }),
});

export const resendOTPSchema = z.object({
    body: z.object({
        email: emailField,
    }),
});

// ============================================
// Password Reset Schemas
// ============================================

export const forgotPasswordSchema = z.object({
    body: z.object({
        email: emailField,
    }),
});

export const resetPasswordSchema = z
    .object({
        body: z.object({
            token: z.string().min(1, 'Reset token is required'),
            newPassword: resetPasswordField,
            confirmPassword: z.string().min(1, 'Please confirm your password'),
        }),
    })
    .superRefine((data, ctx) => {
        if (data.body.newPassword !== data.body.confirmPassword) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Passwords don't match",
                path: ['body', 'confirmPassword'],
            });
        }
    });

export const resetPasswordWithQuerySchema = z
    .object({
        body: z.object({
            newPassword: resetPasswordField,
            confirmPassword: z.string().min(1, 'Please confirm your password'),
        }),
        query: z.object({
            token: z.string().min(1, 'Reset token is required'),
        }),
    })
    .superRefine((data, ctx) => {
        if (data.body.newPassword !== data.body.confirmPassword) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Passwords don't match",
                path: ['body', 'confirmPassword'],
            });
        }
    });

export const validateResetTokenSchema = z.object({
    params: z.object({
        token: z.string().min(1, 'Reset token is required'),
    }),
});

// ============================================
// Social Login Schemas (Optional)
// ============================================

export const googleLoginSchema = z.object({
    body: z.object({
        token: z.string().min(1, 'Google token is required'),
    }),
});

export const facebookLoginSchema = z.object({
    body: z.object({
        token: z.string().min(1, 'Facebook token is required'),
    }),
});

// ============================================
// Logout Schema
// ============================================

export const logoutSchema = z.object({
    body: z.object({
        refreshToken: z.string().optional(),
    }),
});

// ============================================
// ✅ NEW: First Login Password Reset Schema
// ============================================

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
// Type Inference Helpers
// ============================================

export type RegisterInput = z.infer<typeof registerSchema>['body'];
export type SellerRegisterInput = z.infer<typeof sellerRegisterSchema>['body'];
export type AdminRegisterInput = z.infer<typeof adminRegisterSchema>['body'];
export type LoginInput = z.infer<typeof loginSchema>['body'];
export type VerifyOTPInput = z.infer<typeof verifyOTPSchema>['body'];
export type ResendOTPInput = z.infer<typeof resendOTPSchema>['body'];
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>['body'];
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>['body'];
export type ResetPasswordWithQueryInput = {
    body: z.infer<typeof resetPasswordWithQuerySchema>['body'];
    query: z.infer<typeof resetPasswordWithQuerySchema>['query'];
};
export type GoogleLoginInput = z.infer<typeof googleLoginSchema>['body'];
export type FacebookLoginInput = z.infer<typeof facebookLoginSchema>['body'];
export type LogoutInput = z.infer<typeof logoutSchema>['body'];
export type FirstLoginPasswordResetInput = z.infer<typeof firstLoginPasswordResetSchema>['body'];

// ============================================
// Export All Schemas
// ============================================

export const authSchemas = {
    register: registerSchema,
    registerSeller: sellerRegisterSchema,
    registerAdmin: adminRegisterSchema,
    login: loginSchema,
    verifyOTP: verifyOTPSchema,
    resendOTP: resendOTPSchema,
    forgotPassword: forgotPasswordSchema,
    resetPassword: resetPasswordSchema,
    resetPasswordWithQuery: resetPasswordWithQuerySchema,
    validateResetToken: validateResetTokenSchema,
    googleLogin: googleLoginSchema,
    facebookLogin: facebookLoginSchema,
    logout: logoutSchema,
    firstLoginPasswordReset: firstLoginPasswordResetSchema, // ✅ NEW
};

export default authSchemas;