// src/types/auth.types.ts
import { UserRole } from '../../middlewares/auth.middleware';

// ============================================
// Registration Types
// ============================================

export interface RegisterInput {
    email: string;
    password: string;
    full_name: string;
    role?: UserRole;
    phone?: string;
}

export interface SellerRegisterInput {
    email: string;
    password: string;
    full_name: string;
    phone: string;
    role: 'seller';
}

/**
 * Admin registration input - for creating moderator/admin/super_admin accounts
 * Only accessible to super_admin
 */
export interface AdminRegisterInput {
    email: string;
    password: string;
    full_name: string;
    phone?: string;
    role: 'moderator' | 'admin' | 'super_admin';
}

// ============================================
// ✅ NEW: First Login Types
// ============================================

export interface FirstLoginCheckResponse {
    success: boolean;
    data: {
        isFirstLogin: boolean;
        needsPasswordReset: boolean;
    };
}

export interface FirstLoginPasswordResetInput {
    email: string;
    temporaryPassword: string;
    newPassword: string;
    confirmPassword: string;
}

export interface FirstLoginPasswordResetResult {
    success: boolean;
    message: string;
}

// ============================================
// Login Types
// ============================================

export interface LoginInput {
    email: string;
    password: string;
}

export interface RefreshTokenPayload {
    id: string;
    jti: string;
}

// ============================================
// Forgot Password Types
// ============================================

export interface ForgotPasswordInput {
    email: string;
}

export interface ForgotPasswordResponse {
    message: string;
    resetToken?: string;
}

export interface ResetPasswordInput {
    token: string;
    newPassword: string;
    confirmPassword?: string;
}

export interface ResetPasswordResponse {
    message: string;
}

export interface PasswordResetRequest {
    email: string;
    token: string;
    expiresAt: Date;
    used: boolean;
    createdAt: Date;
}

export interface PasswordResetTokenPayload {
    userId: string;
    email: string;
    tokenVersion?: number;
    iat?: number;
    exp?: number;
}

// ============================================
// Password Validation
// ============================================

export interface PasswordRequirements {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumbers: boolean;
    requireSpecialChars: boolean;
}

// ============================================
// API Response Types
// ============================================

export interface AuthApiResponse<T = any> {
    success: boolean;
    data?: T;
    message?: string;
    errors?: string[];
}

export type PasswordResetFlow = 
    | { step: 'request'; data: ForgotPasswordInput }
    | { step: 'reset'; data: ResetPasswordInput };

export interface PasswordResetRateLimit {
    maxAttempts: number;
    windowMinutes: number;
    remainingAttempts: number;
    resetAt: Date;
}

// ============================================
// OTP Types
// ============================================

export interface OTPRequestInput {
    email: string;
}

export interface OTPVerifyInput {
    email: string;
    otp: string;
}

export interface OTPResponse {
    message: string;
    expiresIn?: number;
}

export interface OTPData {
    otp: string;
    expiresAt: Date;
    attempts: number;
    verified: boolean;
}

export interface OTPAudit {
    id: string;
    email: string;
    otp: string;
    expiresAt: Date;
    verifiedAt: Date | null;
    createdAt: Date;
}

// ============================================
// Auth User Types (Base User Only)
// ============================================

export interface AuthUser {
    id: string;
    email: string;
    full_name: string;
    role: UserRole;
    phone?: string | null;
    is_active: boolean;
    token_version?: number;
    avatar_url?: string | null;
    created_at: Date;
    updated_at: Date;
}

// ============================================
// JWT Token Types
// ============================================

export interface TokenPayload {
    id: string;
    email: string;
    full_name: string;
    role: string;
    token_version: number;
}

export type TokenUser = AuthUser | TokenPayload;

// ============================================
// Response Types
// ============================================

export interface RegisterResponse {
    success: boolean;
    message: string;
    data: {
        email: string;
        role: UserRole;
        requiresVerification: boolean;
        nextStep: 'verify_email';
    };
}

export interface SellerRegisterResponse {
    success: boolean;
    message: string;
    data: {
        email: string;
        role: 'seller';
        requiresVerification: boolean;
        nextStep: 'verify_email';
    };
}

export interface AdminRegisterResponse {
    success: boolean;
    message: string;
    data: {
        id: string;
        email: string;
        full_name: string;
        role: 'moderator' | 'admin' | 'super_admin';
        is_active: boolean;
        requiresPasswordReset: boolean;
        nextStep: 'login';
    };
}

export interface LoginResponse {
    success: boolean;
    data: {
        user: AuthUser;
        accessToken: string;
    };
}

// ============================================
// Role-Based Response Types
// ============================================

export interface RoleInfo {
    role: UserRole;
    permissions: string[];
    redirectPath: string;
}

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
    customer: ['browse', 'purchase', 'review'],
    seller: ['browse', 'purchase', 'review', 'manage_store', 'manage_products', 'manage_orders'],
    moderator: ['browse', 'review_stores', 'review_products', 'moderate_content', 'view_all'],
    admin: ['browse', 'review_stores', 'review_products', 'moderate_content', 'view_all', 'manage_users', 'manage_settings'],
    super_admin: ['browse', 'review_stores', 'review_products', 'moderate_content', 'view_all', 'manage_users', 'manage_settings', 'manage_roles'],
};

export const ROLE_REDIRECTS: Record<UserRole, string> = {
    customer: '/',
    seller: '/dashboard',
    moderator: '/moderator/dashboard',
    admin: '/admin/dashboard',
    super_admin: '/super-admin/dashboard',
};

// ============================================
// Auth State Types (Frontend)
// ============================================

export interface AuthState {
    user: AuthUser | null;
    accessToken: string | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    error: string | null;
}

// ============================================
// ✅ NEW: Admin Welcome Email Types
// ============================================

export interface AdminWelcomeEmailParams {
    name: string;
    email: string;
    role: string;
    password: string;
    loginUrl: string;
    appName?: string;
}

// ============================================
// ✅ NEW: First Login Request/Response Types
// ============================================

export interface FirstLoginCheckRequest {
    userId: string;
}

export interface FirstLoginPasswordResetRequest {
    email: string;
    temporary_password: string;
    new_password: string;
    confirm_password: string;
}

export interface FirstLoginPasswordResetResponse {
    success: boolean;
    message: string;
}