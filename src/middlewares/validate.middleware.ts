// src/middlewares/validate.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

declare module 'express-serve-static-core' {
  interface Request {
    validated?: {
      body?: any;
      query?: any;
      params?: any;
    };
  }
}

export const validate = (schema: z.ZodTypeAny) => {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const parsed = (await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      })) as { body?: any; query?: any; params?: any };

      // Attach parsed result; do NOT mutate req.query (Express 5 getter).
      req.validated = parsed;

      // Body and params can still be mutated safely.
      if (parsed.body !== undefined && req.body) {
        Object.keys(req.body).forEach((key) => delete req.body[key]);
        Object.assign(req.body, parsed.body);
      }
      if (parsed.params !== undefined) {
        Object.keys(req.params).forEach((key) => delete req.params[key]);
        Object.assign(req.params, parsed.params);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};