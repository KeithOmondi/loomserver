// src/routes/auth.routes.ts
import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import {
    getMySessions,
    login,
    logout,
    refresh,
    register,
    registerSeller,
    registerAdmin,
    revokeMySession,
    forgotPasswordHandler,
    resetPasswordHandler,
    resetPasswordWithQueryHandler,
    validateResetTokenHandler,
    verifyOTPHandler,
    resendOTPHandler,
} from './auth.controller';
import {
    loginSchema,
    registerSchema,
    sellerRegisterSchema,
    adminRegisterSchema,
    forgotPasswordSchema,
    resetPasswordSchema,
    resetPasswordWithQuerySchema,
    validateResetTokenSchema,
    verifyOTPSchema,
    resendOTPSchema,
    firstLoginPasswordResetSchema, // ✅ NEW
} from './auth.validator';
import { validate } from '../../middlewares/validate.middleware';
import { env } from '../../config/env';
import { protect, requireSuperAdmin } from '../../middlewares/auth.middleware';
import {
    firstLoginPasswordResetHandler, // ✅ NEW
} from '../users/user.controller';

const router = Router();

// Helper function to get client IP (handles IPv6 properly)
// Relies on app.set('trust proxy') so req.ip is the real client, not a spoofable header.
const getClientIp = (req: Request): string => req.ip || req.socket.remoteAddress || 'unknown';

// Rate limiters
const authRateLimiter = rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    max: env.AUTH_RATE_LIMIT_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many attempts. Please try again later.' },
    keyGenerator: (req: Request) => {
        const ip = getClientIp(req);
        const email = req.body?.email || '';
        return email ? `${ip}:${email}` : ip;
    },
});

const otpRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many OTP attempts. Please try again later.' },
    keyGenerator: (req: Request) => {
        const ip = getClientIp(req);
        const email = req.body?.email || '';
        return email ? `otp:${ip}:${email}` : `otp:${ip}`;
    },
});

const resetRateLimiter = rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many reset attempts. Please try again later.' },
    keyGenerator: (req: Request) => {
        const ip = getClientIp(req);
        const email = req.body?.email || '';
        return email ? `${ip}:${email}` : ip;
    },
});

const validateTokenLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many validation requests.' },
    keyGenerator: (req: Request) => {
        return getClientIp(req);
    },
});

// ============================================
// Public Routes
// ============================================

// Customer Registration
router.post('/register', authRateLimiter, validate(registerSchema), register);

// Seller Registration
router.post('/register/seller', authRateLimiter, validate(sellerRegisterSchema), registerSeller);

// Login (shared)
router.post('/login', authRateLimiter, validate(loginSchema), login);
router.post('/refresh', refresh);

// OTP Verification
router.post('/verify-otp', otpRateLimiter, validate(verifyOTPSchema), verifyOTPHandler);
router.post('/resend-otp', otpRateLimiter, validate(resendOTPSchema), resendOTPHandler);

// Password Reset
router.post('/forgot-password', resetRateLimiter, validate(forgotPasswordSchema), forgotPasswordHandler);
router.post('/reset-password', resetRateLimiter, validate(resetPasswordSchema), resetPasswordHandler);
router.post('/reset-password-with-token', resetRateLimiter, validate(resetPasswordWithQuerySchema), resetPasswordWithQueryHandler);

// Token validation
router.get('/validate-reset-token', validateTokenLimiter, validate(validateResetTokenSchema), validateResetTokenHandler);
router.post('/validate-reset-token', validateTokenLimiter, validate(validateResetTokenSchema), validateResetTokenHandler);

// ============================================
// ✅ NEW: First Login Password Reset
// ============================================

/**
 * Reset password on first login (for admin-created accounts)
 * POST /api/auth/first-login/reset-password
 */
router.post(
    '/first-login/reset-password',
    resetRateLimiter,
    validate(firstLoginPasswordResetSchema),
    firstLoginPasswordResetHandler
);

// ============================================
// Admin Routes (Super Admin Only)
// ============================================

// Create moderator/admin accounts (super_admin only)
router.post(
    '/register/admin',
    protect,
    requireSuperAdmin,
    validate(adminRegisterSchema),
    registerAdmin
);

// ============================================
// Protected Routes (require authentication)
// ============================================

router.get('/me/sessions', protect, getMySessions);
router.delete('/me/sessions/:sessionId', protect, revokeMySession);

// No `protect` here — logout must work even with an expired/missing access token
router.post('/logout', logout);

export default router;