// src/controllers/auth.controller.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import {
    loginUser,
    registerUser,
    registerSeller as registerSellerService,
    registerAdmin as registerAdminService,
    forgotPassword,
    resetPassword,
    validateResetToken,
    verifyOTP,
    resendOTP,
} from './auth.service';
import { sendTokenResponse } from '../../utils/sendToken';
import { listActiveSessions, revokeAllUserTokens, revokeSessionById, rotateRefreshToken } from '../../services/token.service';
import { AppError } from '../../utils/response';
import { env } from '../../config/env';
import { findUserById } from '../users/user.service';

const COOKIE_PATH = '/api/v1/auth';

const refreshTokenPayloadSchema = z.object({
    id: z.string().min(1),
    jti: z.string().min(1),
});

// ============================================
// Customer Registration
// ============================================

export const register = asyncHandler(async (req: Request, res: Response) => {
    const user = await registerUser(req.body);

    res.status(201).json({
        success: true,
        message: 'Account created. Please verify your email with the OTP sent to your inbox.',
        data: {
            id: user.id,
            email: user.email,
            role: user.role,
            is_active: user.is_active,
            requiresVerification: true,
            nextStep: 'verify_email',
        },
    });
});

// ============================================
// Seller Registration (Auth Only!)
// ============================================

export const registerSeller = asyncHandler(async (req: Request, res: Response) => {
    const user = await registerSellerService(req.body);

    res.status(201).json({
        success: true,
        message: 'Seller account created. Please verify your email with the OTP sent to your inbox.',
        data: {
            id: user.id,
            email: user.email,
            role: user.role,
            is_active: user.is_active,
            requiresVerification: true,
            nextStep: 'verify_email',
        },
    });
});

// ============================================
// ✅ Admin Registration (for creating moderators/admins/super_admins)
// ============================================

export const registerAdmin = asyncHandler(async (req: Request, res: Response) => {
    
    // Only super_admin can create admin/moderator accounts
    if (!req.user || req.user.role !== 'super_admin') {
        throw new AppError(403, 'Only super administrators can create admin/moderator accounts.');
    }


    const user = await registerAdminService(req.body);

    // ✅ Send welcome email with temporary password (done in service)
    // ✅ User is active by default (is_active = true)

    res.status(201).json({
        success: true,
        message: `${user.role} account created successfully. They will receive an email with their temporary password.`,
        data: {
            id: user.id,
            email: user.email,
            role: user.role,
            full_name: user.full_name,
            is_active: user.is_active, // ✅ true by default
            requiresPasswordReset: true, // ✅ First login requires password reset
            nextStep: 'login', // ✅ Redirect to login, not verify_email
        },
    });
});

// ============================================
// Login
// ============================================

export const login = asyncHandler(async (req: Request, res: Response) => {
    const user = await loginUser(req.body);

    await sendTokenResponse(user, 200, req, res);
});

// ============================================
// OTP Verification Endpoints
// ============================================

export const verifyOTPHandler = asyncHandler(async (req: Request, res: Response) => {
    const { email, otp } = req.body;

    const result = await verifyOTP(email, otp);

    res.status(200).json({
        success: true,
        message: result.message,
    });
});

export const resendOTPHandler = asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body;

    const result = await resendOTP(email);

    res.status(200).json({
        success: true,
        message: result.message,
    });
});

// ============================================
// Logout
// ============================================

export const logout = asyncHandler(async (req: Request, res: Response) => {
    const token = req.cookies?.refreshToken;

    if (token) {
        try {
            const rawDecoded = jwt.verify(token, env.JWT_REFRESH_SECRET, {
                algorithms: ['HS256'],
            });
            const parsed = refreshTokenPayloadSchema.safeParse(rawDecoded);
            if (parsed.success) {
                await revokeAllUserTokens(parsed.data.id);
            }
        } catch {
            // Token invalid/expired/already revoked — nothing to clean up.
        }
    }

    res.clearCookie('refreshToken', { path: COOKIE_PATH });
    res.status(200).json({ success: true, message: 'Logged out successfully.' });
});

// ============================================
// Refresh Token
// ============================================

export const refresh = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.refreshToken;
    if (!token) {
        return next(new AppError(401, 'No refresh token provided.'));
    }

    let rawDecoded: unknown;
    try {
        rawDecoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    } catch {
        res.clearCookie('refreshToken', { path: COOKIE_PATH });
        return next(new AppError(401, 'Invalid or expired refresh token.'));
    }

    const parsed = refreshTokenPayloadSchema.safeParse(rawDecoded);
    if (!parsed.success) {
        res.clearCookie('refreshToken', { path: COOKIE_PATH });
        return next(new AppError(401, 'Malformed refresh token payload.'));
    }
    const decoded = parsed.data;

    let rotated: { id: string } | null = null;
    try {
        rotated = await rotateRefreshToken(decoded.jti, decoded.id);
    } catch (error) {
        if (error instanceof Error && error.message === 'REFRESH_RACE') {
            // A concurrent request already rotated this token and its Set-Cookie holds the
            // valid successor — hand out an access token only, and don't touch the cookie.
            const raceUser = await findUserById(decoded.id);
            if (!raceUser) return next(new AppError(401, 'User no longer exists.'));
            const { password_hash: _ph, ...raceAuthUser } = raceUser;
            return sendTokenResponse(raceAuthUser, 200, req, res, undefined, { accessOnly: true });
        }
        res.clearCookie('refreshToken', { path: COOKIE_PATH });
        if (error instanceof Error && error.message === 'REUSE_DETECTED') {
            return next(new AppError(401, 'Session invalidated. Please log in again.'));
        }
        return next(new AppError(401, 'Refresh token is no longer valid.'));
    }

    const user = await findUserById(decoded.id);
    if (!user) {
        res.clearCookie('refreshToken', { path: COOKIE_PATH });
        return next(new AppError(401, 'User no longer exists.'));
    }

    const { password_hash, ...authUser } = user;

    await sendTokenResponse(authUser, 200, req, res, undefined, { refreshTokenId: rotated!.id });
});

// ============================================
// Session Management
// ============================================

export const getMySessions = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    const sessions = await listActiveSessions(req.user.id);

    const currentToken = req.cookies?.refreshToken;
    let currentSessionId: string | null = null;
    if (currentToken) {
        try {
            const decoded = jwt.verify(currentToken, env.JWT_REFRESH_SECRET, {
                algorithms: ['HS256'],
            }) as { jti: string };
            currentSessionId = decoded.jti;
        } catch {
            // Current cookie invalid/expired
        }
    }

    res.status(200).json({
        success: true,
        sessions: sessions.map((s) => ({ ...s, is_current: s.id === currentSessionId })),
    });
});

export const revokeMySession = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, 'Authentication required.');

    const { sessionId } = req.params;

    if (typeof sessionId !== 'string') {
        throw new AppError(400, 'Invalid session id.');
    }

    const revoked = await revokeSessionById(req.user.id, sessionId);

    if (!revoked) {
        throw new AppError(404, 'Session not found or already revoked.');
    }

    res.status(200).json({ success: true, message: 'Session revoked.' });
});

// ============================================
// Forgot Password & Reset Password
// ============================================

export const forgotPasswordHandler = asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body;

    const result = await forgotPassword({ email });

    const response: any = {
        success: true,
        message: result.message,
    };

    if (process.env.NODE_ENV === 'development' && result.resetToken) {
        response.resetToken = result.resetToken;
    }

    res.status(200).json(response);
});

export const validateResetTokenHandler = asyncHandler(async (req: Request, res: Response) => {
    const token = req.query.token as string || req.body.token;

    if (!token) {
        throw new AppError(400, 'Reset token is required.');
    }

    const result = await validateResetToken(token);

    if (!result.valid) {
        throw new AppError(400, 'Invalid or expired reset token.');
    }

    res.status(200).json({
        success: true,
        message: 'Token is valid.',
        email: result.email,
    });
});

export const resetPasswordHandler = asyncHandler(async (req: Request, res: Response) => {
    const { token, newPassword, confirmPassword } = req.body;

    if (newPassword !== confirmPassword) {
        throw new AppError(400, 'Passwords do not match.');
    }

    const result = await resetPassword({ token, newPassword });

    res.status(200).json({
        success: true,
        message: result.message,
    });
});

export const resetPasswordWithQueryHandler = asyncHandler(async (req: Request, res: Response) => {
    const token = req.query.token as string;
    const { newPassword, confirmPassword } = req.body;

    if (!token) {
        throw new AppError(400, 'Reset token is required.');
    }

    if (newPassword !== confirmPassword) {
        throw new AppError(400, 'Passwords do not match.');
    }

    const result = await resetPassword({ token, newPassword });

    res.status(200).json({
        success: true,
        message: result.message,
    });
});