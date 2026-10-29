// src/config/env.ts
import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Load environment variables from .env file (server/.env, two levels up from src/config)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
    // Core
    PORT: z.coerce.number().int().positive().default(8000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().min(1, 'APP_NAME is required').default('Marketplace'), // ✅ NEW

    // URLs — validated as real URLs so a typo'd value fails at boot, not
    // at request time inside CORS/Cloudinary/wherever it's consumed.
    API_URL: z.string().url().default('http://localhost:8000'),

    // CLIENT_URL can be a single URL or comma-separated list for multiple origins
    CLIENT_URL: z.string().transform((val) => {
        if (val.includes(',')) {
            return val.split(',').map(url => url.trim());
        }
        return val;
    }).default('http://localhost:3000'),

    // Database
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // Redis Configuration
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_DB: z.coerce.number().int().nonnegative().default(0),
    REDIS_KEY_PREFIX: z.string().default('marketplace:'),

    // Redis Connection Pool
    REDIS_POOL_MIN: z.coerce.number().int().positive().default(2),
    REDIS_POOL_MAX: z.coerce.number().int().positive().default(10),
    REDIS_CONNECT_TIMEOUT: z.coerce.number().int().positive().default(10000),
    REDIS_COMMAND_TIMEOUT: z.coerce.number().int().positive().default(5000),

    // Cloudinary
    CLOUDINARY_CLOUD_NAME: z.string().min(1, 'CLOUDINARY_CLOUD_NAME is required'),
    CLOUDINARY_API_KEY: z.string().min(1, 'CLOUDINARY_API_KEY is required'),
    CLOUDINARY_API_SECRET: z.string().min(1, 'CLOUDINARY_API_SECRET is required'),

    // JWT — minimum length enforced so a weak/short secret fails at boot,
    // not silently in production. 32 chars = 256 bits if hex-encoded, which
    // matches what `crypto.randomBytes(32).toString('hex')` (64 hex chars)
    // comfortably exceeds.
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

    // Cookies — COOKIE_DOMAIN matters once you're on a real domain (e.g.
    // .yourmarketplace.com) so the refresh cookie is scoped correctly across
    // subdomains; leave unset in dev.
    COOKIE_DOMAIN: z.string().optional(),

    // Password hashing — configurable so you can raise it later without a
    // code change, and so tests can lower it for speed.
    BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

    // Rate limiting (auth routes) — used by the limiter we're adding to
    // app.ts / auth.routes.ts.
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000), // 15 min
    AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

    // API Rate Limiting (global)
    API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000), // 1 min
    API_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(300),

    // Sensitive Operations Rate Limiting
    SENSITIVE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60 * 1000), // 1 hour
    SENSITIVE_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

    // Cache Configuration
    CACHE_TTL_SHORT: z.coerce.number().int().positive().default(60), // 1 minute
    CACHE_TTL_MEDIUM: z.coerce.number().int().positive().default(300), // 5 minutes
    CACHE_TTL_LONG: z.coerce.number().int().positive().default(3600), // 1 hour
    CACHE_TTL_DAY: z.coerce.number().int().positive().default(86400), // 24 hours

    // Session Configuration
    SESSION_TTL: z.coerce.number().int().positive().default(7 * 24 * 60 * 60), // 7 days
    SESSION_PREFIX: z.string().default('session:'),

    // Brevo (transactional email) — used by sendMail.ts for OTP delivery
    // (password reset, and eventually anywhere else that needs email OTP).
    // No .default() on the API key or sender email — a missing key should
    // fail loudly at boot rather than let email silently no-op in prod.
    BREVO_API_KEY: z.string().min(1, 'BREVO_API_KEY is required'),
    BREVO_SENDER_EMAIL: z.string().email('BREVO_SENDER_EMAIL must be a valid email'),
    BREVO_SENDER_NAME: z.string().min(1).default('MtechHub'),

    // ============================================
    // M-Pesa (Safaricom Daraja API)
    // ============================================
    // Credentials come from the Safaricom Developer Portal.
    // Sandbox: https://developer.safaricom.co.ke
    //
    // In development the callback URL must be a publicly reachable
    // HTTPS endpoint (ngrok, cloudflared, etc.) — Daraja will not POST
    // to localhost.
    //
    // Sandbox defaults:
    //   MPESA_ENVIRONMENT=sandbox
    //   MPESA_SHORTCODE=174379
    //   MPESA_PASSKEY=bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919
    MPESA_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
    MPESA_CONSUMER_KEY: z.string().min(1, 'MPESA_CONSUMER_KEY is required'),
    MPESA_CONSUMER_SECRET: z.string().min(1, 'MPESA_CONSUMER_SECRET is required'),
    MPESA_SHORTCODE: z.string().min(1, 'MPESA_SHORTCODE is required'),
    MPESA_PASSKEY: z.string().min(1, 'MPESA_PASSKEY is required'),
    MPESA_CALLBACK_URL: z
        .string()
        .url('MPESA_CALLBACK_URL must be a valid HTTPS URL'),
    // Optional — Safaricom egress IPs for callback source verification.
    // Comma-separated. If empty, IP verification is skipped (dev only).
    MPESA_CALLBACK_IPS: z
        .string()
        .optional()
        .transform((val) =>
            val ? val.split(',').map((ip) => ip.trim()).filter(Boolean) : [],
        ),

    // Scaling / Load Balancing
    INSTANCE_ID: z.string().default(() => {
        // Generate a unique ID for this instance
        return `instance_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }),
    ENABLE_CLUSTER: z.coerce.boolean().default(false),
    CLUSTER_WORKERS: z.coerce.number().int().positive().default(0), // 0 = use CPU cores

    // Number of reverse-proxy hops in front of the app (Render/Railway/nginx = 1).
    // Required so req.ip is the real client, not the proxy — rate limits and the
    // M-Pesa callback IP check both depend on it. Use 0 when running with no proxy.
    TRUST_PROXY: z.coerce.number().int().nonnegative().default(1),

    // Health check
    HEALTH_CHECK_PATH: z.string().default('/health'),
    HEALTH_CHECK_INTERVAL: z.coerce.number().int().positive().default(10000), // 10 seconds
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    console.error(parsed.error.format());
    process.exit(1);
}

// Safaricom's published Daraja callback egress IPs. Used when running against the
// production Daraja environment and MPESA_CALLBACK_IPS isn't set, so a forged
// payment-success callback from any other host is dropped.
const SAFARICOM_CALLBACK_IPS = [
    '196.201.214.200', '196.201.214.206', '196.201.213.114', '196.201.214.207',
    '196.201.214.208', '196.201.213.44', '196.201.212.127', '196.201.212.138',
    '196.201.212.129', '196.201.212.136', '196.201.212.74', '196.201.212.69',
];

const mpesaCallbackIps =
    parsed.data.MPESA_CALLBACK_IPS.length === 0 && parsed.data.MPESA_ENVIRONMENT === 'production'
        ? SAFARICOM_CALLBACK_IPS
        : parsed.data.MPESA_CALLBACK_IPS;

if (parsed.data.NODE_ENV === 'production') {
    if (parsed.data.JWT_SECRET === parsed.data.JWT_REFRESH_SECRET) {
        console.error('❌ JWT_SECRET and JWT_REFRESH_SECRET must be different in production.');
        process.exit(1);
    }
    if (parsed.data.MPESA_ENVIRONMENT === 'sandbox') {
        console.warn('⚠️ MPESA_ENVIRONMENT is sandbox — real payments will NOT work.');
    }
}

export const env = {
    ...parsed.data,
    IS_PRODUCTION: parsed.data.NODE_ENV === 'production',
    IS_DEVELOPMENT: parsed.data.NODE_ENV === 'development',
    IS_TEST: parsed.data.NODE_ENV === 'test',

    // Helper to check if an origin is allowed
    isOriginAllowed: (origin: string): boolean => {
        const clientUrl = parsed.data.CLIENT_URL;
        if (Array.isArray(clientUrl)) {
            return clientUrl.includes(origin);
        }
        return clientUrl === origin;
    },

    // Redis configuration object
    redis: {
        host: parsed.data.REDIS_HOST,
        port: parsed.data.REDIS_PORT,
        password: parsed.data.REDIS_PASSWORD,
        db: parsed.data.REDIS_DB,
        keyPrefix: parsed.data.REDIS_KEY_PREFIX,
        pool: {
            min: parsed.data.REDIS_POOL_MIN,
            max: parsed.data.REDIS_POOL_MAX,
        },
        timeout: {
            connect: parsed.data.REDIS_CONNECT_TIMEOUT,
            command: parsed.data.REDIS_COMMAND_TIMEOUT,
        },
    },

    // Cache TTLs
    cache: {
        short: parsed.data.CACHE_TTL_SHORT,
        medium: parsed.data.CACHE_TTL_MEDIUM,
        long: parsed.data.CACHE_TTL_LONG,
        day: parsed.data.CACHE_TTL_DAY,
    },

    // Rate limiting
    rateLimit: {
        auth: {
            windowMs: parsed.data.AUTH_RATE_LIMIT_WINDOW_MS,
            max: parsed.data.AUTH_RATE_LIMIT_MAX_ATTEMPTS,
        },
        api: {
            windowMs: parsed.data.API_RATE_LIMIT_WINDOW_MS,
            max: parsed.data.API_RATE_LIMIT_MAX_ATTEMPTS,
        },
        sensitive: {
            windowMs: parsed.data.SENSITIVE_RATE_LIMIT_WINDOW_MS,
            max: parsed.data.SENSITIVE_RATE_LIMIT_MAX_ATTEMPTS,
        },
    },

    // Session
    session: {
        ttl: parsed.data.SESSION_TTL,
        prefix: parsed.data.SESSION_PREFIX,
    },

    // ============================================
    // M-Pesa (Daraja) — grouped accessor
    // ============================================
    mpesa: {
        environment: parsed.data.MPESA_ENVIRONMENT,
        isSandbox: parsed.data.MPESA_ENVIRONMENT === 'sandbox',
        consumerKey: parsed.data.MPESA_CONSUMER_KEY,
        consumerSecret: parsed.data.MPESA_CONSUMER_SECRET,
        shortcode: parsed.data.MPESA_SHORTCODE,
        passkey: parsed.data.MPESA_PASSKEY,
        callbackUrl: parsed.data.MPESA_CALLBACK_URL,
        /** Empty array = skip source-IP verification (dev only) */
        callbackIps: mpesaCallbackIps,
    },

    // Scaling
    scaling: {
        instanceId: parsed.data.INSTANCE_ID,
        enableCluster: parsed.data.ENABLE_CLUSTER,
        workers: parsed.data.CLUSTER_WORKERS,
    },

    // ✅ Application name
    APP_NAME: parsed.data.APP_NAME,
} as const;

// Export types
export type Env = typeof env;