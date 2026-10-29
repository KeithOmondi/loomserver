// src/utils/sendToken.ts
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { StringValue } from 'ms';
import ms from 'ms';
import { env } from '../config/env';
import { createRefreshToken } from '../services/token.service';
import { AuthUser } from '../features/auth/auth.types';

export const sendTokenResponse = async (
    user: AuthUser, // AuthUser only - no seller/store data
    statusCode: number,
    req: Request,
    res: Response,
    extra?: Record<string, unknown>,
    opts?: {
        // Reuse a refresh row that rotateRefreshToken already created, instead of inserting a second one.
        refreshTokenId?: string;
        // Issue only a fresh access token and leave the browser's refresh cookie untouched.
        accessOnly?: boolean;
    }
) => {

    // Extract user data from AuthUser
    const userId = user.id;
    const userEmail = user.email;
    const userFullName = user.full_name;
    const userRole = user.role;
    const userPhone = user.phone || null;
    const userIsActive = user.is_active;
    
    // ✅ Get token_version from user or default to 1
    const userTokenVersion = (user as any).token_version ?? 1;

    // ✅ Generate access token WITH token_version
    const accessToken = jwt.sign(
        {
            id: userId,
            email: userEmail,
            full_name: userFullName,
            role: userRole,
            token_version: userTokenVersion, // ✅ ADD THIS
        },
        env.JWT_SECRET,
        {
            expiresIn: env.JWT_ACCESS_EXPIRES_IN as StringValue,
            algorithm: 'HS256',
        }
    );

    const userResponse = {
        id: userId,
        full_name: userFullName,
        email: userEmail,
        role: userRole,
        phone: userPhone,
        is_active: userIsActive,
    };

    if (opts?.accessOnly) {
        return res.status(statusCode).json({ success: true, accessToken, user: userResponse, ...extra });
    }

    const refreshTokenId =
        opts?.refreshTokenId ??
        (
            await createRefreshToken(userId, {
                userAgent: req.headers['user-agent'],
                ipAddress: req.ip,
            })
        ).id;

    // Generate refresh token
    const refreshToken = jwt.sign(
        { id: userId, jti: refreshTokenId },
        env.JWT_REFRESH_SECRET,
        {
            expiresIn: env.JWT_REFRESH_EXPIRES_IN as StringValue,
            algorithm: 'HS256',
        }
    );

    // Set cookie
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: env.IS_PRODUCTION,
        sameSite: env.IS_PRODUCTION ? 'none' : 'lax',
        domain: env.COOKIE_DOMAIN,
        path: '/',
        maxAge: ms(env.JWT_REFRESH_EXPIRES_IN as StringValue),
    });

    return res.status(statusCode).json({
        success: true,
        accessToken,
        user: userResponse,
        ...extra,
    });
};