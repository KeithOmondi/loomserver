// src/app.ts
import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './features/auth/auth.routes';
import userRoutes from './features/users/user.routes';
import storeRoutes from './features/store/store.routes';
import categoryRoutes from './features/categories/category.routes';
import productRoutes from './features/products/product.routes';
import sellerRoutes from "./features/seller/seller.routes"
import moderatorRoutes from "./features/moderator/moderation.routes"
import ordersRoutes from "./features/orders/order.routes"
import orderActionsRoutes from './features/orders/order-actions.routes';
import cartRoutes from "./features/cart/cart.routes"
import wishlistRoutes from './features/wishlist/wishlist.routes';
import paymentRoutes from './features/payments/payment.routes';
import addressRoutes from './features/addresses/address.routes';
import { disputesRouter, refundsRouter, returnsRouter, uploadsRouter } from './features/aftersales/aftersales.routes';
import { accountRouter, catalogExtrasRouter, contentRouter, questionsRouter } from './features/platform/platform.public.routes';
import { sellerHubRouter, variantsRouter } from './features/platform/platform.seller.routes';
import adminRoutes from './features/platform/platform.admin.routes';
import payoutsRoutes from './features/payouts/payouts.routes';
import { errorMiddleware } from './middlewares/error.middleware';
import { env } from './config/env';
import { redisService } from './config/redis';
import { pool } from './config/db';

const app: Application = express();

// Behind a reverse proxy (Render, Railway, nginx...) req.ip must come from the
// proxy's X-Forwarded-For, otherwise every user shares one IP for rate limiting.
app.set('trust proxy', env.TRUST_PROXY);
app.disable('x-powered-by');

// ============================================
// Security Middleware
// ============================================

app.use(helmet());

// ============================================
// CORS Configuration
// ============================================

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    if (!env.IS_PRODUCTION) {
      const allowedDevOrigins = [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:5174',
      ];
      
      if (allowedDevOrigins.includes(origin) || 
          origin.includes('localhost') || 
          origin.includes('127.0.0.1')) {
        return callback(null, true);
      }
    }

    if (env.isOriginAllowed(origin)) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'Cookie',
    'Set-Cookie',
    'X-API-Key',
    'X-Request-ID',
    'X-CSRF-Token',
    'X-Cart-Token',
  ],
  exposedHeaders: [
    'Content-Length',
    'Content-Type',
    'X-Request-ID',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-Total-Count',
  ],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// ============================================
// Standard Middleware
// ============================================

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());

// ============================================
// Health Check
// ============================================

app.get('/health', async (req: Request, res: Response) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: env.NODE_ENV,
    services: {
      redis: false,
      database: false,
    }
  };

  // Check Redis
  try {
    health.services.redis = await redisService.ping();
  } catch (error) {
    health.services.redis = false;
  }

  // Check Database
  try {
    await pool.query('SELECT 1');
    health.services.database = true;
  } catch (error) {
    health.services.database = false;
  }

  const statusCode = health.services.redis && health.services.database ? 200 : 503;
  res.status(statusCode).json(health);
});

// ============================================
// API Routes
// ============================================

// Global per-IP limiter (auth routes additionally have their own stricter ones).
// Safaricom's callback is exempt so a busy IP window can never drop a payment confirmation.
app.use(
  '/api/v1',
  rateLimit({
    windowMs: env.rateLimit.api.windowMs,
    max: env.rateLimit.api.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/payments/mpesa/callback'),
    message: { success: false, error: 'Too many requests. Please slow down.' },
  }),
);

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/stores', storeRoutes);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/products', variantsRouter);
app.use('/api/v1/products', catalogExtrasRouter);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/orders', orderActionsRoutes);
app.use('/api/v1/orders', ordersRoutes);
app.use('/api/v1/sellers', sellerRoutes);
app.use('/api/v1/moderator', moderatorRoutes);
app.use('/api/v1/cart', cartRoutes);
app.use('/api/v1/wishlist', wishlistRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/addresses', addressRoutes);
app.use('/api/v1/payouts', payoutsRoutes);
app.use('/api/v1/questions', questionsRouter);
app.use('/api/v1/seller-hub', sellerHubRouter);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1', contentRouter);
app.use('/api/v1', accountRouter);
app.use('/api/v1/returns', returnsRouter);
app.use('/api/v1/refunds', refundsRouter);
app.use('/api/v1/disputes', disputesRouter);
app.use('/api/v1/uploads', uploadsRouter);

// ============================================
// Error Handling
// ============================================

app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use(errorMiddleware);

// ============================================
// Keep-alive ping (production only)
// ============================================

if (env.IS_PRODUCTION) {
  setInterval(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      await fetch(`${env.API_URL}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      console.log('🏓 Keep-alive ping sent');
    } catch (err) {
      console.warn('⚠️ Keep-alive ping failed:', err);
    }
  }, 10 * 60 * 1000);
}

export default app;