// src/types/express.d.ts
import { UserRole } from '../middlewares/auth.middleware';
import { StoreProfile } from './store.types';

declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                email: string;
                full_name: string;
                role: UserRole;
                token_version: number;
                // store_id is removed - we fetch it from database when needed
            };
            store?: StoreProfile; // Store data attached by middleware
            resourceStoreId?: string; // For store ownership checks
        }
    }
}

export {};