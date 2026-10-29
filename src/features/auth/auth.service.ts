// src/services/auth.service.ts
import { AppError } from "../../utils/response";
import { 
    findUserByEmail, 
    createUser, 
    createAdminUser,
    verifyPassword, 
    updatePassword 
} from "../users/user.service";
import { AuthUser } from "./auth.types";
import {
    LoginInput,
    RegisterInput,
    SellerRegisterInput,
    AdminRegisterInput,
    ForgotPasswordInput,
    ResetPasswordInput,
    PasswordResetRequest,
    PasswordResetTokenPayload,
    OTPData,
} from "./auth.types";
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { addMinutes, isAfter } from 'date-fns';
import { sendMail } from "../../utils/sendMail";
import { getPasswordResetTemplate, getOTPTemplate, getWelcomeTemplate, getAdminWelcomeTemplate, sendAdminWelcomeEmail } from "../../utils/emailTemplates";
import { env } from "../../config/env";
import { generateOTP } from "../../utils/generateOTP";
import { pool } from "../../config/db";
import { redisService } from "../../config/redis";
import bcrypt from 'bcrypt';

const DUMMY_HASH = '$2b$12$ujy9TW9y60x05L9kkTFZBO76H3igVuKp5aY/2eqe90S8eAKkccv02';

const RESET_TOKEN_EXPIRY_MINUTES = 15;
const JWT_RESET_SECRET = process.env.JWT_RESET_SECRET || 'your-reset-secret-key';
const OTP_EXPIRY_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 3;

const passwordResetStore = new Map<string, PasswordResetRequest>();

// ============================================
// Customer Registration
// ============================================

export const registerUser = async (input: RegisterInput): Promise<AuthUser> => {
    // Check if email exists
    const existingUser = await findUserByEmail(input.email);
    if (existingUser) {
        throw new AppError(409, 'An account with this email already exists.');
    }

    // ✅ Ensure only valid roles for createUser
    const validRoles = ['customer', 'seller'];
    const role = input.role && validRoles.includes(input.role) ? input.role : 'customer';

    const user = await createUser({
        email: input.email,
        password: input.password,
        full_name: input.full_name,
        role: role as 'customer' | 'seller',
        phone: input.phone,
        is_active: false, // Requires OTP verification
    });

    await sendOTP(user.email);
    return user;
};

// ============================================
// Seller Registration (Auth Only!)
// ============================================

export const registerSeller = async (input: SellerRegisterInput): Promise<AuthUser> => {
    // 1. Check if email already exists
    const existingUser = await findUserByEmail(input.email);
    if (existingUser) {
        throw new AppError(409, 'An account with this email already exists.');
    }

    // 2. Create user with role 'seller'
    const user = await createUser({
        email: input.email,
        password: input.password,
        full_name: input.full_name,
        role: 'seller',
        phone: input.phone,
        is_active: false, // Requires OTP verification
    });

    // 3. Send OTP for email verification
    await sendOTP(user.email);

    // 4. Return user only
    return user;
};

// ============================================
// ✅ Admin Registration (for creating moderators/admins/super_admins)
// ============================================

export const registerAdmin = async (input: AdminRegisterInput): Promise<AuthUser> => {

    // Check if email exists
    const existingUser = await findUserByEmail(input.email);
    
    if (existingUser) {
        throw new AppError(409, 'An account with this email already exists.');
    }

    // ✅ Use createAdminUser for elevated roles (moderator, admin, super_admin)
    // ✅ User is active by default (is_active = true)
    const user = await createAdminUser({
        email: input.email,
        password: input.password,
        full_name: input.full_name,
        role: input.role,
        phone: input.phone,
        is_active: true, // ✅ Active by default - no OTP needed
    });

    // ✅ Send welcome email with temporary password (NO OTP)
    await sendAdminWelcomeEmail({
        name: user.full_name,
        email: user.email,
        role: user.role,
        password: input.password,
        loginUrl: `${env.CLIENT_URL}/login`,
        appName: env.APP_NAME || 'LOOM',
    });

    return user;
};

// ============================================
// Login
// ============================================

export const loginUser = async (input: LoginInput): Promise<AuthUser> => {
    const user = await findUserByEmail(input.email);

    const isValid = await verifyPassword(input.password, user?.password_hash ?? DUMMY_HASH);

    if (!user || !isValid) {
        throw new AppError(401, 'Invalid email or password.');
    }

    if (!user.is_active) {
        throw new AppError(403, 'Please verify your email first.');
    }

    const { password_hash, ...authUser } = user;
    return authUser;
};

// ============================================
// OTP Functions
// ============================================

export const sendOTP = async (email: string): Promise<void> => {
    const otp = generateOTP(6);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000);

    const otpData: OTPData = {
        otp,
        expiresAt,
        attempts: 0,
        verified: false,
    };

    await redisService.cacheSet(`otp:${email}`, otpData, OTP_EXPIRY_SECONDS);

    const { html, text } = getOTPTemplate({
        otp,
        expiresInMinutes: Math.floor(OTP_EXPIRY_SECONDS / 60),
        appName: env.BREVO_SENDER_NAME,
    });

    await sendMail({
        to: email,
        subject: `Verify Your Email - ${env.BREVO_SENDER_NAME}`,
        html,
        text,
    });
};

export const verifyOTP = async (email: string, otp: string): Promise<{ message: string }> => {
    const user = await findUserByEmail(email);
    if (!user) {
        throw new AppError(404, 'User not found.');
    }

    if (user.is_active) {
        throw new AppError(400, 'Account is already verified.');
    }

    const otpData = await redisService.cacheGet<OTPData>(`otp:${email}`);
    if (!otpData) {
        throw new AppError(400, 'OTP expired. Please request a new one.');
    }

    if (otpData.verified) {
        throw new AppError(400, 'OTP already used.');
    }

    if (otpData.attempts >= OTP_MAX_ATTEMPTS) {
        await redisService.cacheDelete(`otp:${email}`);
        throw new AppError(400, 'Too many failed attempts. Please request a new OTP.');
    }

    if (new Date() > new Date(otpData.expiresAt)) {
        await redisService.cacheDelete(`otp:${email}`);
        throw new AppError(400, 'OTP expired. Please request a new one.');
    }

    if (otpData.otp !== otp) {
        otpData.attempts += 1;
        const remainingSeconds = Math.floor((new Date(otpData.expiresAt).getTime() - Date.now()) / 1000);
        await redisService.cacheSet(`otp:${email}`, otpData, Math.max(remainingSeconds, 1));

        const remainingAttempts = OTP_MAX_ATTEMPTS - otpData.attempts;
        throw new AppError(400, `Invalid OTP. ${remainingAttempts} attempts remaining.`);
    }

    otpData.verified = true;
    await redisService.cacheSet(`otp:${email}`, otpData, 60);

    // Activate user
    await pool.query(
        `UPDATE users SET is_active = true, updated_at = NOW() WHERE email = $1`,
        [email]
    );

    await redisService.cacheDelete(`otp:${email}`);

    // Send welcome email
    const { html, text } = getWelcomeTemplate({
        name: user.full_name,
        appName: env.BREVO_SENDER_NAME,
    });

    await sendMail({
        to: email,
        subject: `Welcome to ${env.BREVO_SENDER_NAME}! 🎉`,
        html,
        text,
    });

    return {
        message: 'Email verified successfully. You can now log in.',
    };
};

export const resendOTP = async (email: string): Promise<{ message: string }> => {
    const user = await findUserByEmail(email);
    if (!user) {
        throw new AppError(404, 'User not found.');
    }

    if (user.is_active) {
        throw new AppError(400, 'Account is already verified.');
    }

    const otpData = await redisService.cacheGet<OTPData>(`otp:${email}`);
    if (otpData && !otpData.verified && new Date() < new Date(otpData.expiresAt)) {
        const { html, text } = getOTPTemplate({
            otp: otpData.otp,
            expiresInMinutes: Math.floor((new Date(otpData.expiresAt).getTime() - Date.now()) / 60000),
            appName: env.BREVO_SENDER_NAME,
        });

        await sendMail({
            to: email,
            subject: `Verify Your Email - ${env.BREVO_SENDER_NAME}`,
            html,
            text,
        });

        return { message: 'OTP resent successfully to your email.' };
    }

    await sendOTP(email);
    return { message: 'OTP sent successfully to your email.' };
};

// ============================================
// Forgot Password
// ============================================

export const forgotPassword = async (input: ForgotPasswordInput): Promise<{ message: string; resetToken?: string }> => {
    const user = await findUserByEmail(input.email);

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = addMinutes(new Date(), RESET_TOKEN_EXPIRY_MINUTES);

    if (user) {
        const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
        
        passwordResetStore.set(hashedToken, {
            email: user.email,
            token: hashedToken,
            expiresAt,
            used: false,
            createdAt: new Date(),
        });

        const resetLink = `${env.CLIENT_URL}/reset-password?token=${resetToken}`;
        const { html, text } = getPasswordResetTemplate({
            resetLink,
            expiresInHours: Math.floor(RESET_TOKEN_EXPIRY_MINUTES / 60),
            appName: env.BREVO_SENDER_NAME,
        });

        await sendMail({
            to: user.email,
            subject: `Reset Your Password - ${env.BREVO_SENDER_NAME}`,
            html,
            text,
        });
        
        return { 
            message: 'If an account exists with this email, a reset link has been sent.',
            resetToken: resetToken
        };
    }

    return { 
        message: 'If an account exists with this email, a reset link has been sent.'
    };
};

// ============================================
// Reset Password
// ============================================

export const resetPassword = async (input: ResetPasswordInput): Promise<{ message: string }> => {
    let userId: string | null = null;
    let email: string | null = null;
    let storedRequest: PasswordResetRequest | null = null;

    try {
        const decoded = jwt.verify(input.token, JWT_RESET_SECRET) as PasswordResetTokenPayload;
        userId = decoded.userId;
        email = decoded.email;
    } catch {
        const hashedToken = crypto.createHash('sha256').update(input.token).digest('hex');
        const stored = passwordResetStore.get(hashedToken);
        
        if (stored && !stored.used && isAfter(stored.expiresAt, new Date())) {
            storedRequest = stored;
            email = stored.email;
            
            const user = await findUserByEmail(email);
            if (user) {
                userId = user.id;
            }
        }
    }

    if (userId) {
        const user = await findUserByEmail(email || '');
        if (user && user.id === userId) {
            await updatePassword(userId, input.newPassword);
            
            if (storedRequest) {
                storedRequest.used = true;
                passwordResetStore.set(storedRequest.token, storedRequest);
            }
            
            return { message: 'Password has been reset successfully.' };
        }
    }

    if (storedRequest && !userId) {
        storedRequest.used = true;
        passwordResetStore.set(storedRequest.token, storedRequest);
    }

    throw new AppError(400, 'Invalid or expired reset token.');
};

// ============================================
// Validate Reset Token
// ============================================

export const validateResetToken = async (token: string): Promise<{ valid: boolean; email?: string }> => {
    try {
        const decoded = jwt.verify(token, JWT_RESET_SECRET) as PasswordResetTokenPayload;
        const user = await findUserByEmail(decoded.email);
        if (user && user.id === decoded.userId) {
            return { valid: true, email: decoded.email };
        }
    } catch {
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
        const stored = passwordResetStore.get(hashedToken);
        
        if (stored && !stored.used && isAfter(stored.expiresAt, new Date())) {
            return { valid: true, email: stored.email };
        }
    }
    
    return { valid: false };
};

// ============================================
// Cleanup
// ============================================

export const cleanupExpiredResetTokens = (): void => {
    const now = new Date();
    for (const [key, value] of passwordResetStore.entries()) {
        if (isAfter(now, value.expiresAt) || value.used) {
            passwordResetStore.delete(key);
        }
    }
};

export const clearAllResetTokens = (): void => {
    passwordResetStore.clear();
};