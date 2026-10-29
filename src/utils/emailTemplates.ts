// src/utils/emailTemplates.ts

interface OTPTemplateParams {
    otp: string;
    expiresInMinutes?: number;
    appName?: string;
}

interface PasswordResetTemplateParams {
    resetLink: string;
    expiresInHours?: number;
    appName?: string;
}

interface WelcomeTemplateParams {
    name: string;
    appName?: string;
}

interface SellerWelcomeTemplateParams {
    name: string;
    storeName: string;
    appName: string;
    verificationLink: string;
    appUrl?: string;
}

// ✅ NEW: Admin Welcome Email Params
interface AdminWelcomeTemplateParams {
    name: string;
    email: string;
    role: string;
    password: string;
    loginUrl: string;
    appName?: string;
}

/**
 * OTP Verification Email Template
 */
export const getOTPTemplate = ({
    otp,
    expiresInMinutes = 10,
    appName = 'Marketplace',
}: OTPTemplateParams): { html: string; text: string } => {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Verify Your Email</title>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
                .otp-code { 
                    font-size: 36px; 
                    font-weight: bold; 
                    color: #4F46E5; 
                    background: white;
                    padding: 15px;
                    text-align: center;
                    letter-spacing: 8px;
                    border-radius: 8px;
                    margin: 20px 0;
                    border: 2px dashed #e5e7eb;
                }
                .footer { margin-top: 30px; font-size: 12px; color: #6B7280; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 20px; }
                .warning { color: #DC2626; font-size: 14px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="margin: 0;">Verify Your Email</h1>
                </div>
                <div class="content">
                    <p>Hello,</p>
                    <p>Thank you for signing up for <strong>${appName}</strong>!</p>
                    <p>Please use the following OTP to verify your email address:</p>
                    <div class="otp-code">${otp}</div>
                    <p>This OTP is valid for <strong>${expiresInMinutes} minutes</strong>.</p>
                    <p class="warning">⚠️ Never share this OTP with anyone.</p>
                    <p>If you didn't request this, please ignore this email.</p>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const text = `
        Verify Your Email - ${appName}
        
        Hello,
        
        Thank you for signing up for ${appName}!
        
        Please use the following OTP to verify your email address:
        
        ${otp}
        
        This OTP is valid for ${expiresInMinutes} minutes.
        
        ⚠️ Never share this OTP with anyone.
        
        If you didn't request this, please ignore this email.
        
        ---
        ${appName}
        ${new Date().getFullYear()}
    `;

    return { html, text };
};

/**
 * Password Reset Email Template
 */
export const getPasswordResetTemplate = ({
    resetLink,
    expiresInHours = 24,
    appName = 'Marketplace',
}: PasswordResetTemplateParams): { html: string; text: string } => {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Reset Your Password</title>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
                .button {
                    display: inline-block;
                    background: #4F46E5;
                    color: white;
                    padding: 12px 30px;
                    text-decoration: none;
                    border-radius: 6px;
                    margin: 20px 0;
                    font-weight: bold;
                }
                .footer { margin-top: 30px; font-size: 12px; color: #6B7280; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 20px; }
                .warning { color: #DC2626; font-size: 14px; }
                .link { word-break: break-all; font-size: 12px; color: #4F46E5; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="margin: 0;">Reset Your Password</h1>
                </div>
                <div class="content">
                    <p>Hello,</p>
                    <p>We received a request to reset your password for <strong>${appName}</strong>.</p>
                    <p>Click the button below to reset your password:</p>
                    <div style="text-align: center;">
                        <a href="${resetLink}" class="button">Reset Password</a>
                    </div>
                    <p>This link is valid for <strong>${expiresInHours} hours</strong>.</p>
                    <p class="warning">⚠️ If you didn't request this, please ignore this email or contact support.</p>
                    <p>Or copy and paste this link into your browser:</p>
                    <p class="link">${resetLink}</p>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const text = `
        Reset Your Password - ${appName}
        
        Hello,
        
        We received a request to reset your password for ${appName}.
        
        Click the link below to reset your password:
        
        ${resetLink}
        
        This link is valid for ${expiresInHours} hours.
        
        ⚠️ If you didn't request this, please ignore this email or contact support.
        
        ---
        ${appName}
        ${new Date().getFullYear()}
    `;

    return { html, text };
};

/**
 * Welcome Email Template (after verification)
 */
export const getWelcomeTemplate = ({
    name,
    appName = 'Marketplace',
}: WelcomeTemplateParams): { html: string; text: string } => {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Welcome</title>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
                .footer { margin-top: 30px; font-size: 12px; color: #6B7280; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="margin: 0;">Welcome to ${appName}! 🎉</h1>
                </div>
                <div class="content">
                    <p>Hello <strong>${name}</strong>,</p>
                    <p>Welcome to <strong>${appName}</strong>! We're excited to have you on board.</p>
                    <p>You can now explore our marketplace and start your journey with us.</p>
                    <p>If you have any questions, feel free to reach out to our support team.</p>
                    <p>Happy shopping! 🛍️</p>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const text = `
        Welcome to ${appName}! 🎉
        
        Hello ${name},
        
        Welcome to ${appName}! We're excited to have you on board.
        
        You can now explore our marketplace and start your journey with us.
        
        If you have any questions, feel free to reach out to our support team.
        
        Happy shopping! 🛍️
        
        ---
        ${appName}
        ${new Date().getFullYear()}
    `;

    return { html, text };
};

/**
 * Seller Welcome Email Template
 */
export const getSellerWelcomeTemplate = ({
    name,
    storeName,
    appName,
    verificationLink,
    appUrl = '#',
}: SellerWelcomeTemplateParams): { html: string; text: string } => {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Welcome to ${appName} as a Seller!</title>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
                .store-name { color: #4CAF50; font-weight: bold; }
                .steps { background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
                .steps ol { font-size: 16px; line-height: 2; }
                .steps a { color: #4CAF50; text-decoration: none; }
                .note { background: #fff3cd; padding: 15px; border-radius: 8px; border-left: 4px solid #ffc107; margin: 20px 0; }
                .note p { margin: 0; color: #856404; }
                .button {
                    display: inline-block;
                    background: #4F46E5;
                    color: white;
                    padding: 12px 30px;
                    text-decoration: none;
                    border-radius: 6px;
                    font-weight: bold;
                }
                .footer { margin-top: 30px; font-size: 12px; color: #6B7280; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="margin: 0;">Welcome to ${appName}! 🚀</h1>
                </div>
                <div class="content">
                    <p>Hello <strong>${name}</strong>,</p>
                    
                    <p style="font-size: 16px; line-height: 1.6;">
                        Congratulations on becoming a seller! Your store 
                        <span class="store-name">"${storeName}"</span> 
                        has been successfully created.
                    </p>
                    
                    <div class="steps">
                        <h2 style="margin-top: 0;">📋 Next Steps:</h2>
                        <ol>
                            <li>
                                <strong>Verify your email</strong> - 
                                <a href="${verificationLink}">Click here to verify</a>
                            </li>
                            <li><strong>Complete your store setup</strong> - Add logo, banner, and store policies</li>
                            <li><strong>List your first product</strong> - Start selling to customers</li>
                            <li><strong>Wait for admin approval</strong> - We'll review your store shortly</li>
                        </ol>
                    </div>
                    
                    <div class="note">
                        <p>⚠️ <strong>Note:</strong> Your store is pending admin approval. 
                        You'll receive a notification once it's approved.</p>
                    </div>
                    
                    <p style="font-size: 16px; line-height: 1.6;">
                        Need help getting started? Check our 
                        <a href="${appUrl}" style="color: #4CAF50; text-decoration: none;">Seller Guide</a>.
                    </p>
                    
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
                    
                    <p style="color: #666; font-size: 14px;">
                        Happy selling! 🎉<br />
                        <strong>The ${appName} Team</strong>
                    </p>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const text = `
        Welcome to ${appName}, ${name}! 🚀
        
        Congratulations on becoming a seller! Your store "${storeName}" has been successfully created.
        
        📋 Next Steps:
        
        1. Verify your email - ${verificationLink}
        2. Complete your store setup - Add logo, banner, and store policies
        3. List your first product - Start selling to customers
        4. Wait for admin approval - We'll review your store shortly
        
        ⚠️ Note: Your store is pending admin approval. You'll receive a notification once it's approved.
        
        Need help getting started? Check our Seller Guide: ${appUrl}
        
        Happy selling! 🎉
        The ${appName} Team
        
        ---
        ${appName}
        ${new Date().getFullYear()}
    `;

    return { html, text };
};

// ============================================
// ✅ NEW: Admin Welcome Email Template
// ============================================

/**
 * Admin Welcome Email Template
 * Sent when Super Admin creates a moderator/admin account
 */
export const getAdminWelcomeTemplate = ({
    name,
    email,
    role,
    password,
    loginUrl,
    appName = 'Marketplace',
}: AdminWelcomeTemplateParams): { html: string; text: string } => {
    const roleDisplay = role.charAt(0).toUpperCase() + role.slice(1).replace('_', ' ');

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Welcome to ${appName}</title>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
                .password-box { 
                    background: white;
                    padding: 15px;
                    text-align: center;
                    border-radius: 8px;
                    margin: 20px 0;
                    border: 2px dashed #4F46E5;
                    font-size: 20px;
                    font-weight: bold;
                    color: #4F46E5;
                    letter-spacing: 2px;
                }
                .button {
                    display: inline-block;
                    background: #4F46E5;
                    color: white;
                    padding: 12px 30px;
                    text-decoration: none;
                    border-radius: 6px;
                    font-weight: bold;
                }
                .warning-box { 
                    background: #FEF3C7;
                    border-left: 4px solid #F59E0B;
                    padding: 15px;
                    margin: 20px 0;
                    border-radius: 4px;
                }
                .warning-box ul { margin: 8px 0 0 0; padding-left: 20px; }
                .footer { margin-top: 30px; font-size: 12px; color: #6B7280; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="margin: 0;">Welcome to ${appName}! 🎉</h1>
                </div>
                <div class="content">
                    <p>Hello <strong>${name}</strong>,</p>
                    
                    <p>Your <strong>${roleDisplay}</strong> account has been created by the Super Administrator.</p>
                    
                    <p>You can now log in using the temporary password below:</p>
                    
                    <div class="password-box">
                        ${password}
                    </div>
                    
                    <div style="text-align: center; margin: 20px 0;">
                        <a href="${loginUrl}" class="button">Log In Now</a>
                    </div>
                    
                    <div class="warning-box">
                        <strong>⚠️ Security Notice:</strong>
                        <ul>
                            <li>This is a temporary password.</li>
                            <li>Please reset your password after logging in.</li>
                            <li>Never share your password with anyone.</li>
                        </ul>
                    </div>
                    
                    <p style="font-size: 14px; color: #6B7280;">
                        If you have any questions, please contact support.
                    </p>
                    
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
                    
                    <p style="color: #666; font-size: 14px;">
                        Best regards,<br />
                        <strong>The ${appName} Team</strong>
                    </p>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const text = `
        Welcome to ${appName}! 🎉
        
        Hello ${name},
        
        Your ${roleDisplay} account has been created by the Super Administrator.
        
        You can now log in using the temporary password below:
        
        🔐 ${password}
        
        Log in here: ${loginUrl}
        
        ⚠️ Security Notice:
        - This is a temporary password.
        - Please reset your password after logging in.
        - Never share your password with anyone.
        
        If you have any questions, please contact support.
        
        Best regards,
        The ${appName} Team
        
        ---
        ${appName}
        ${new Date().getFullYear()}
    `;

    return { html, text };
};

// ============================================
// ✅ NEW: Send Admin Welcome Email
// ============================================

/**
 * Send welcome email to admin/moderator created by Super Admin
 */
export const sendAdminWelcomeEmail = async (params: AdminWelcomeTemplateParams): Promise<void> => {
    const { html, text } = getAdminWelcomeTemplate(params);

    const { sendMail } = await import('./sendMail');

    await sendMail({
        to: params.email,
        subject: `Welcome to ${params.appName} - Your ${params.role} Account`,
        html,
        text,
    });
};

// ============================================
// Export All Templates
// ============================================

export const emailTemplates = {
    getOTPTemplate,
    getPasswordResetTemplate,
    getWelcomeTemplate,
    getSellerWelcomeTemplate,
    getAdminWelcomeTemplate,
    sendAdminWelcomeEmail,
};

export default emailTemplates;