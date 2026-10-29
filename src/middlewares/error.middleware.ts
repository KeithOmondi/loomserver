import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env';
import { AppError } from '../utils/response';

export const errorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // 1. Intercept Zod Schema Validation Issues
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: 'Validation Error',
      details: err.issues.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  // 2. Intercept Intentional App Operational Errors
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
    });
    return;
  }

  // 3. Intercept Postgres Unique Constraint Violations (e.g. duplicating emails)
  if (err.code === '23505') {
    res.status(409).json({
      success: false,
      error: 'Resource conflict: This record already exists.',
    });
    return;
  }

  // 4. Client errors raised by Express/body-parser/CORS (bad JSON, payload too large, blocked origin)
  if (err?.message === 'Not allowed by CORS') {
    res.status(403).json({ success: false, error: 'Origin not allowed' });
    return;
  }
  const status = err?.status ?? err?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({
      success: false,
      error: err.type === 'entity.parse.failed' ? 'Malformed JSON body' : err.message || 'Bad request',
    });
    return;
  }

  // 5. Critical Server Exceptions Fallback
  console.error('💥 Unhandled Exception Core Error:', err);
  
  res.status(500).json({
    success: false,
    error: env.IS_PRODUCTION ? 'Internal Server Error' : err.message || err,
  });
};