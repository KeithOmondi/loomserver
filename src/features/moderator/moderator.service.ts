// src/features/moderator/moderator.service.ts

import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import { StoreStatus } from '../store/store.types';
import {
    ModerationItem,
    ModerationItemWithDetails,
    ModerationQueue,
    ModerationStats,
    ModerationHistoryEntry,
    ModerationTarget,
    ModerationStatus,
    ModerationPriority,
    ModerationAction,
    ModerationFilters,
    BulkModerationResult,
    PendingStoreReview,
    ModeratorSellerRow,
} from './moderator.types';

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_PRIORITY: ModerationPriority = ModerationPriority.MEDIUM;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ============================================
// HELPER FUNCTIONS
// ============================================

const mapRowToModerationItem = (row: any): ModerationItem => ({
    id: row.id,
    target_type: row.target_type,
    target_id: row.target_id,
    status: row.status,
    priority: row.priority,
    submitted_by: row.submitted_by,
    submitted_at: row.submitted_at,
    moderated_by: row.moderated_by,
    moderated_at: row.moderated_at,
    notes: row.notes,
    metadata: row.metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
});

const mapRowToHistoryEntry = (row: any): ModerationHistoryEntry => ({
    id: row.id,
    moderator_id: row.moderator_id,
    moderator_name: row.moderator_name,
    moderator_email: row.moderator_email,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    target_name: row.target_name ?? null,
    notes: row.notes,
    metadata: row.metadata,
    created_at: row.created_at,
});

const SORT_COLUMN_MAP: Record<string, string> = {
    created_at: 'created_at',
    priority: 'priority',
    status: 'status',
    updated_at: 'updated_at',
};

const SORT_ORDER_MAP: Record<string, string> = {
    asc: 'ASC',
    desc: 'DESC',
};

/**
 * Maps a `stores.status` value to a `ModerationStatus` value the UI understands.
 */
function mapStoreStatusToModerationStatus(
    storeStatus: string
): ModerationStatus {
    switch (storeStatus) {
        case 'active':
            return ModerationStatus.APPROVED;
        case 'pending_approval':
            return ModerationStatus.PENDING;
        case 'rejected':
            return ModerationStatus.REJECTED;
        case 'suspended':
            return ModerationStatus.SUSPENDED;
        case 'draft':
            return ModerationStatus.PENDING;
        case 'closed':
            return ModerationStatus.REMOVED;
        default:
            return ModerationStatus.PENDING;
    }
}

function mapModerationFilterToStoreStatuses(
    statusFilter: string
): string[] | null {
    switch (statusFilter) {
        case 'pending':
            return ['pending_approval', 'draft'];
        case 'approved':
            return ['active'];
        case 'rejected':
            return ['rejected'];
        case 'suspended':
            return ['suspended'];
        case 'in_review':
            return ['pending_approval'];
        case 'removed':
            return ['closed'];
        default:
            return null;
    }
}

// ============================================
// CREATE MODERATION ITEM
// ============================================

export const createModerationItem = async (
    targetType: ModerationTarget,
    targetId: string,
    submittedBy: string,
    priority: ModerationPriority = DEFAULT_PRIORITY,
    metadata?: Record<string, any>,
    notes?: string
): Promise<ModerationItem> => {
    const existing = await pool.query(
        `SELECT id FROM moderation_queue 
         WHERE target_type = $1 AND target_id = $2 AND status IN ($3, $4)
         LIMIT 1`,
        [targetType, targetId, ModerationStatus.PENDING, ModerationStatus.IN_REVIEW]
    );

    if (existing.rows.length > 0) {
        const result = await pool.query(
            `SELECT * FROM moderation_queue WHERE id = $1`,
            [existing.rows[0].id]
        );
        return mapRowToModerationItem(result.rows[0]);
    }

    const result = await pool.query(
        `INSERT INTO moderation_queue (
            target_type, target_id, status, priority,
            submitted_by, submitted_at, notes, metadata,
            created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, NOW(), NOW())
        RETURNING *`,
        [
            targetType,
            targetId,
            ModerationStatus.PENDING,
            priority,
            submittedBy,
            notes || null,
            metadata || null,
        ]
    );

    return mapRowToModerationItem(result.rows[0]);
};

// ============================================
// GET PENDING STORES FOR MODERATION
// ============================================

export const getPendingStoresForModeration = async (
    page: number = 1,
    limit: number = DEFAULT_LIMIT,
    search?: string
): Promise<{ items: PendingStoreReview[]; total: number; pages: number }> => {
    const offset = (page - 1) * limit;
    const conditions: string[] = [
        'mq.target_type = $1',
        'mq.status = $2',
        'st.deleted_at IS NULL',
    ];
    const values: any[] = [ModerationTarget.STORE, ModerationStatus.PENDING];
    let paramCount = 3;

    if (search) {
        conditions.push(`(st.name ILIKE $${paramCount} OR sb.business_name ILIKE $${paramCount})`);
        values.push(`%${search}%`);
        paramCount++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countQuery = `
        SELECT COUNT(DISTINCT mq.id) as total
        FROM moderation_queue mq
        JOIN stores st ON st.id = mq.target_id
        JOIN sellers sb ON sb.id = st.seller_id
        ${whereClause}
    `;
    const countResult = await pool.query(countQuery, values);
    const total = parseInt(countResult.rows[0]?.total || '0');

    const query = `
        SELECT 
            mq.*,
            jsonb_build_object(
                'id', st.id,
                'name', st.name,
                'slug', st.slug,
                'description', st.description,
                'logo_url', st.logo_url,
                'banner_url', st.banner_url,
                'contact_email', st.contact_email,
                'contact_phone', st.contact_phone,
                'location', st.location,
                'country', st.country,
                'social_links', st.social_links,
                'type', st.type,
                'category', st.category,
                'status', st.status,
                'is_approved', st.is_approved,
                'is_active', st.is_active,
                'created_at', st.created_at,
                'updated_at', st.updated_at,
                'total_products', st.total_products,
                'total_orders', st.total_orders,
                'total_reviews', st.total_reviews,
                'average_rating', st.average_rating,
                'seller_id', st.seller_id
            ) as store,
            jsonb_build_object(
                'id', sb.id,
                'user_id', sb.user_id,
                'legal_business_name', sb.business_name,
                'trading_name', sb.trading_name,
                'business_type', sb.business_type,
                'country', sb.country,
                'state', sb.state,
                'city', sb.city,
                'business_address', sb.business_address,
                'business_phone', sb.business_phone,
                'status', sb.status,
                'verification_status', sb.verification_status,
                'rating', sb.rating,
                'total_reviews', sb.total_reviews,
                'total_orders', sb.total_orders,
                'total_products', sb.total_products,
                'total_stores', sb.total_stores,
                'fulfillment_rate', sb.fulfillment_rate,
                'response_rate', sb.response_rate,
                'email', u.email,
                'full_name', u.full_name,
                'phone', u.phone,
                'user_joined_at', u.created_at
            ) as seller,
            COALESCE(
                (SELECT COUNT(*) FROM products WHERE store_id = st.id AND deleted_at IS NULL),
                0
            ) as products_count,
            COALESCE(
                (SELECT COUNT(*) FROM store_reviews WHERE store_id = st.id AND deleted_at IS NULL),
                0
            ) as reviews_count,
            COALESCE(
                (SELECT COUNT(*) FROM orders WHERE store_id = st.id AND deleted_at IS NULL),
                0
            ) as orders_count
        FROM moderation_queue mq
        JOIN stores st ON st.id = mq.target_id
        JOIN sellers sb ON sb.id = st.seller_id
        JOIN users u ON u.id = sb.user_id
        ${whereClause}
        ORDER BY 
            CASE mq.priority 
                WHEN 'urgent' THEN 1 
                WHEN 'high' THEN 2 
                WHEN 'medium' THEN 3 
                WHEN 'low' THEN 4 
            END ASC,
            mq.created_at ASC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;
    values.push(limit, offset);

    const result = await pool.query(query, values);

    const items: PendingStoreReview[] = result.rows.map((row) => ({
        moderation_item: mapRowToModerationItem(row),
        store: row.store,
        seller: row.seller,
        products_count: parseInt(row.products_count || '0'),
        reviews_count: parseInt(row.reviews_count || '0'),
        orders_count: parseInt(row.orders_count || '0'),
        review_history: [],
    }));

    return {
        items,
        total,
        pages: Math.ceil(total / limit),
    };
};

// ============================================
// GET ALL STORES FOR MODERATION
// ============================================

export const getAllStoresForModeration = async (
    page: number = 1,
    limit: number = DEFAULT_LIMIT,
    search?: string,
    statusFilter?: string
): Promise<{ items: PendingStoreReview[]; total: number; pages: number }> => {
    const offset = (page - 1) * limit;
    const conditions: string[] = ['st.deleted_at IS NULL'];
    const values: any[] = [];
    let paramCount = 1;

    if (statusFilter && statusFilter.trim() !== '') {
        const dbStatuses = mapModerationFilterToStoreStatuses(statusFilter.trim());
        if (dbStatuses && dbStatuses.length > 0) {
            conditions.push(`st.status = ANY($${paramCount}::text[])`);
            values.push(dbStatuses);
            paramCount++;
        }
    }

    if (search) {
        conditions.push(
            `(st.name ILIKE $${paramCount} OR sb.business_name ILIKE $${paramCount})`
        );
        values.push(`%${search}%`);
        paramCount++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query(
        `SELECT COUNT(*) as total
         FROM stores st
         JOIN sellers sb ON sb.id = st.seller_id
         ${whereClause}`,
        values
    );
    const total = parseInt(countResult.rows[0]?.total || '0');

    const query = `
        SELECT 
            st.id   AS store_pk,
            st.*,
            jsonb_build_object(
                'id', sb.id,
                'user_id', sb.user_id,
                'business_name', sb.business_name,
                'trading_name', sb.trading_name,
                'business_type', sb.business_type,
                'country', sb.country,
                'state', sb.state,
                'city', sb.city,
                'business_address', sb.business_address,
                'business_phone', sb.business_phone,
                'status', sb.status,
                'verification_status', sb.verification_status,
                'rating', sb.rating,
                'total_reviews', sb.total_reviews,
                'total_orders', sb.total_orders,
                'total_products', sb.total_products,
                'total_stores', sb.total_stores,
                'fulfillment_rate', sb.fulfillment_rate,
                'response_rate', sb.response_rate,
                'email', u.email,
                'full_name', u.full_name,
                'phone', u.phone,
                'user_joined_at', u.created_at
            ) as seller
        FROM stores st
        JOIN sellers sb ON sb.id = st.seller_id
        JOIN users   u  ON u.id  = sb.user_id
        ${whereClause}
        ORDER BY 
            CASE st.status
                WHEN 'pending_approval' THEN 1
                WHEN 'draft'            THEN 2
                WHEN 'active'           THEN 3
                WHEN 'rejected'         THEN 4
                WHEN 'suspended'        THEN 5
                WHEN 'closed'           THEN 6
                ELSE 7
            END ASC,
            st.created_at DESC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;
    values.push(limit, offset);

    const result = await pool.query(query, values);

    const items: PendingStoreReview[] = result.rows.map((row) => ({
        moderation_item: {
            id: row.id,
            target_type: ModerationTarget.STORE,
            target_id: row.id,
            status: mapStoreStatusToModerationStatus(row.status),
            priority: ModerationPriority.MEDIUM,
            submitted_by: row.seller_id,
            submitted_at: row.created_at,
            moderated_by: row.approved_by ?? undefined,
            moderated_at: row.approved_at ?? undefined,
            notes: row.rejection_reason ?? undefined,
            metadata: undefined,
            created_at: row.created_at,
            updated_at: row.updated_at,
        },
        store: {
            id: row.id,
            name: row.name,
            slug: row.slug,
            seller_id: row.seller_id,
            status: row.status,
            is_approved: row.is_approved,
            created_at: row.created_at,
            updated_at: row.updated_at,
            social_links: row.social_links ?? {},
            type: row.type,
            category: row.category,
            description: row.description,
            tagline: row.tagline,
            logo_url: row.logo_url,
            banner_url: row.banner_url,
            cover_image_url: row.cover_image_url,
            contact_email: row.contact_email,
            contact_phone: row.contact_phone,
            support_hours: row.support_hours,
            location: row.location,
            country: row.country,
            timezone: row.timezone,
            sub_categories: row.sub_categories ?? [],
            currency: row.currency,
            language: row.language,
            return_policy: row.return_policy,
            shipping_origin: row.shipping_origin,
            is_active: row.is_active,
            rejection_reason: row.rejection_reason,
            total_products: row.total_products,
            total_orders: row.total_orders,
            total_reviews: row.total_reviews,
            average_rating: row.average_rating,
            view_count: row.view_count,
        },
        seller: row.seller,
        products_count: parseInt(row.total_products || '0'),
        reviews_count: parseInt(row.total_reviews || '0'),
        orders_count: parseInt(row.total_orders || '0'),
        review_history: [],
    }));

    return {
        items,
        total,
        pages: Math.ceil(total / limit),
    };
};

// ============================================
// GET ALL SELLERS FOR MODERATION
// ============================================

export const getAllSellersForModeration = async (
    page: number = 1,
    limit: number = DEFAULT_LIMIT,
    search?: string,
    statusFilter?: string
): Promise<{ items: ModeratorSellerRow[]; total: number; pages: number }> => {
    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (statusFilter && statusFilter.trim() !== '') {
        const f = statusFilter.trim();
        if (f === 'pending') {
            conditions.push(
                `s.status IN ('pending', 'kyc_submitted', 'kyc_update_pending')`
            );
        } else if (f === 'verified') {
            conditions.push(`s.verification_status = 'verified'`);
        } else if (f === 'rejected') {
            conditions.push(`s.verification_status = 'rejected'`);
        } else if (f === 'suspended') {
            conditions.push(`s.verification_status = 'suspended'`);
        } else {
            conditions.push(`s.status = $${paramCount++}`);
            values.push(f);
        }
    }

    if (search) {
        conditions.push(
            `(s.business_name ILIKE $${paramCount} OR u.full_name ILIKE $${paramCount} OR u.email ILIKE $${paramCount})`
        );
        values.push(`%${search}%`);
        paramCount++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
        `SELECT COUNT(DISTINCT s.id) as total
         FROM sellers s
         JOIN users u ON u.id = s.user_id
         ${whereClause}`,
        values
    );
    const total = parseInt(countResult.rows[0]?.total || '0');

    const query = `
        SELECT 
            s.id as seller_id,
            s.user_id,
            s.business_name as legal_business_name,
            s.trading_name,
            s.business_type,
            s.country,
            s.state,
            s.city,
            s.business_address,
            s.business_phone,
            s.verification_status,
            s.status,
            s.tax_id,
            s.registration_number,
            s.payout_method,
            s.bank_account_name,
            s.bank_account_number,
            s.bank_routing_number,
            s.bank_name,
            s.bank_country,
            s.paypal_email,
            s.mpesa_phone,
            s.kyc_documents,
            s.created_at,
            s.updated_at,
            jsonb_build_object(
                'id', u.id,
                'full_name', u.full_name,
                'email', u.email,
                'phone', u.phone
            ) as user
        FROM sellers s
        JOIN users u ON u.id = s.user_id
        ${whereClause}
        ORDER BY 
            CASE s.verification_status
                WHEN 'pending'   THEN 1
                WHEN 'rejected'  THEN 2
                WHEN 'suspended' THEN 3
                WHEN 'verified'  THEN 4
                ELSE 5
            END ASC,
            s.created_at DESC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;
    values.push(limit, offset);

    const result = await pool.query(query, values);

    const items: ModeratorSellerRow[] = result.rows.map((row) => ({
        id: row.seller_id,
        priority: 'medium',
        status: row.verification_status || 'pending',
        submitted_at: row.created_at ?? new Date().toISOString(),
        seller: {
            id: row.seller_id,
            user_id: row.user_id,
            legal_business_name: row.legal_business_name,
            trading_name: row.trading_name,
            business_type: row.business_type,
            country: row.country,
            state: row.state,
            city: row.city,
            business_address: row.business_address,
            business_phone: row.business_phone,
            verification_status: row.verification_status,
            status: row.status,
            tax_id: row.tax_id,
            registration_number: row.registration_number,
            payout_method: row.payout_method,
            bank_account_name: row.bank_account_name,
            bank_account_number: row.bank_account_number,
            bank_routing_number: row.bank_routing_number,
            bank_name: row.bank_name,
            bank_country: row.bank_country,
            paypal_email: row.paypal_email,
            mpesa_phone: row.mpesa_phone,
            kyc_documents: Array.isArray(row.kyc_documents)
                ? row.kyc_documents
                : typeof row.kyc_documents === 'string'
                ? JSON.parse(row.kyc_documents)
                : [],
            user: row.user,
            created_at: row.created_at,
            updated_at: row.updated_at,
        },
    }));

    return {
        items,
        total,
        pages: Math.ceil(total / limit),
    };
};

// ============================================
// GET MODERATION QUEUE
// ============================================

export const getModerationQueue = async (
    filters: ModerationFilters = {}
): Promise<{ items: ModerationItem[]; pagination: any }> => {
    const {
        target_type,
        status = 'pending',
        priority,
        search,
        page = 1,
        limit = 20,
        sortBy = 'created_at',
        sortOrder = 'desc',
        date_from,
        date_to,
    } = filters;

    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (target_type) {
        conditions.push(`target_type = $${paramCount++}`);
        values.push(target_type);
    }

    if (status) {
        conditions.push(`status = $${paramCount++}`);
        values.push(status);
    }

    if (priority) {
        conditions.push(`priority = $${paramCount++}`);
        values.push(priority);
    }

    if (search) {
        conditions.push(`(notes ILIKE $${paramCount} OR target_id::text ILIKE $${paramCount})`);
        values.push(`%${search}%`);
        paramCount++;
    }

    if (date_from) {
        conditions.push(`submitted_at >= $${paramCount++}`);
        values.push(date_from);
    }

    if (date_to) {
        conditions.push(`submitted_at <= $${paramCount++}`);
        values.push(date_to);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const safeSortBy = SORT_COLUMN_MAP[sortBy] || 'created_at';
    const safeSortOrder = SORT_ORDER_MAP[sortOrder] || 'DESC';

    const countResult = await pool.query(
        `SELECT COUNT(*) FROM moderation_queue ${whereClause}`,
        values
    );
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(
        `SELECT * FROM moderation_queue 
         ${whereClause}
         ORDER BY ${safeSortBy} ${safeSortOrder}
         LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
        [...values, limit, offset]
    );

    const items = result.rows.map(mapRowToModerationItem);

    return {
        items,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        },
    };
};

// ============================================
// GET MODERATION QUEUE SUMMARY
// ============================================

export const getModerationQueueSummary = async (): Promise<ModerationQueue> => {
    const totalsResult = await pool.query(
        `SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) as in_review,
            SUM(CASE WHEN status IN ('approved', 'rejected', 'flagged', 'suspended', 'removed', 'resolved') THEN 1 ELSE 0 END) as resolved
        FROM moderation_queue`
    );

    const totals = totalsResult.rows[0] || {};

    const byTypeResult = await pool.query(
        `SELECT target_type, COUNT(*) as count 
         FROM moderation_queue 
         WHERE status = 'pending' 
         GROUP BY target_type`
    );

    const by_type: Record<string, number> = {};
    byTypeResult.rows.forEach((row) => {
        by_type[row.target_type] = parseInt(row.count);
    });

    const byPriorityResult = await pool.query(
        `SELECT priority, COUNT(*) as count 
         FROM moderation_queue 
         WHERE status = 'pending' 
         GROUP BY priority`
    );

    const by_priority: Record<string, number> = {};
    byPriorityResult.rows.forEach((row) => {
        by_priority[row.priority] = parseInt(row.count);
    });

    const itemsResult = await pool.query(
        `SELECT * FROM moderation_queue 
         WHERE status = 'pending' 
         ORDER BY 
             CASE priority 
                 WHEN 'urgent' THEN 1 
                 WHEN 'high' THEN 2 
                 WHEN 'medium' THEN 3 
                 WHEN 'low' THEN 4 
             END ASC,
             created_at ASC 
         LIMIT 10`
    );

    const items = itemsResult.rows.map(mapRowToModerationItem);

    return {
        pending: parseInt(totals.pending || '0'),
        in_review: parseInt(totals.in_review || '0'),
        resolved: parseInt(totals.resolved || '0'),
        by_type,
        by_priority,
        items,
    };
};

// ============================================
// GET MODERATION STATS
// ============================================

export const getModerationStats = async (): Promise<ModerationStats> => {
    const result = await pool.query(
        `SELECT 
            COUNT(*) as total_reviewed,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
            SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
            SUM(CASE WHEN status = 'flagged' THEN 1 ELSE 0 END) as flagged,
            SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as suspended,
            SUM(CASE WHEN status = 'removed' THEN 1 ELSE 0 END) as removed,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) as in_review,
            AVG(EXTRACT(EPOCH FROM (COALESCE(moderated_at, NOW()) - submitted_at))/3600) as response_time_avg,
            CASE 
                WHEN COUNT(*) > 0 
                THEN (SUM(CASE WHEN status IN ('approved', 'rejected', 'resolved') THEN 1 ELSE 0 END)::float / COUNT(*) * 100)
                ELSE 0 
            END as resolution_rate,
            SUM(CASE WHEN submitted_at::date = CURRENT_DATE THEN 1 ELSE 0 END) as today_pending,
            SUM(CASE WHEN submitted_at::date > CURRENT_DATE - INTERVAL '7 days' THEN 1 ELSE 0 END) as this_week_pending
        FROM moderation_queue`
    );

    const row = result.rows[0] || {};
    return {
        total_reviewed: parseInt(row.total_reviewed || '0'),
        approved: parseInt(row.approved || '0'),
        rejected: parseInt(row.rejected || '0'),
        flagged: parseInt(row.flagged || '0'),
        suspended: parseInt(row.suspended || '0'),
        removed: parseInt(row.removed || '0'),
        pending: parseInt(row.pending || '0'),
        in_review: parseInt(row.in_review || '0'),
        response_time_avg: parseFloat(row.response_time_avg || '0'),
        resolution_rate: parseFloat(row.resolution_rate || '0'),
        today_pending: parseInt(row.today_pending || '0'),
        this_week_pending: parseInt(row.this_week_pending || '0'),
    };
};

// ============================================
// GET STORE MODERATION STATS
// ============================================

export interface StoreModerationStats {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    inactive: number;
    deleted: number;
    suspended: number;
    total_products: number;
    total_orders: number;
    category_distribution: Array<{ category: string; count: number }>;
}

export const getStoreModerationStats = async (): Promise<StoreModerationStats> => {
    const result = await pool.query(
        `SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN st.status = 'pending_approval' AND st.deleted_at IS NULL THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN st.status = 'active'           AND st.deleted_at IS NULL THEN 1 ELSE 0 END) as approved,
            SUM(CASE WHEN st.status = 'rejected'         AND st.deleted_at IS NULL THEN 1 ELSE 0 END) as rejected,
            SUM(CASE WHEN st.status = 'suspended'        AND st.deleted_at IS NULL THEN 1 ELSE 0 END) as suspended,
            SUM(CASE WHEN st.status = 'draft'            AND st.deleted_at IS NULL THEN 1 ELSE 0 END) as inactive,
            SUM(CASE WHEN st.deleted_at IS NOT NULL THEN 1 ELSE 0 END) as deleted,
            COALESCE(SUM(CASE WHEN st.deleted_at IS NULL THEN st.total_products ELSE 0 END), 0) as total_products,
            COALESCE(SUM(CASE WHEN st.deleted_at IS NULL THEN st.total_orders   ELSE 0 END), 0) as total_orders
        FROM stores st`
    );

    const row = result.rows[0] || {};

    const categoryResult = await pool.query(
        `SELECT 
            COALESCE(category, 'uncategorized') as category,
            COUNT(*) as count
        FROM stores
        WHERE deleted_at IS NULL
        GROUP BY COALESCE(category, 'uncategorized')
        ORDER BY count DESC`
    );

    const category_distribution = categoryResult.rows.map((r) => ({
        category: r.category,
        count: parseInt(r.count || '0'),
    }));

    return {
        total: parseInt(row.total || '0'),
        pending: parseInt(row.pending || '0'),
        approved: parseInt(row.approved || '0'),
        rejected: parseInt(row.rejected || '0'),
        inactive: parseInt(row.inactive || '0'),
        deleted: parseInt(row.deleted || '0'),
        suspended: parseInt(row.suspended || '0'),
        total_products: parseInt(row.total_products || '0'),
        total_orders: parseInt(row.total_orders || '0'),
        category_distribution,
    };
};

// ============================================
// GET MODERATOR STATS WITH STORES
// ============================================

interface ModeratorStatsWithStores extends ModerationStats {
    stores: StoreModerationStats;
}

export const getModeratorStatsWithStores = async (): Promise<ModeratorStatsWithStores> => {
    const [stats, storeStats] = await Promise.all([
        getModerationStats(),
        getStoreModerationStats(),
    ]);

    return {
        ...stats,
        stores: storeStats,
    };
};

// ============================================
// GET MODERATION ITEM BY ID
// ============================================

export const getModerationItemById = async (
    id: string
): Promise<ModerationItemWithDetails | null> => {
    const result = await pool.query(
        `SELECT 
            mq.*,
            u.full_name as submitter_name,
            u.email as submitter_email,
            u.role as submitter_role,
            mu.full_name as moderator_name,
            mu.email as moderator_email
        FROM moderation_queue mq
        LEFT JOIN users u ON u.id = mq.submitted_by
        LEFT JOIN users mu ON mu.id = mq.moderated_by
        WHERE mq.id = $1`,
        [id]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const row = result.rows[0];
    return {
        ...mapRowToModerationItem(row),
        submitter: {
            id: row.submitted_by,
            full_name: row.submitter_name,
            email: row.submitter_email,
            role: row.submitter_role,
        },
        moderator: row.moderated_by ? {
            id: row.moderated_by,
            full_name: row.moderator_name,
            email: row.moderator_email,
        } : undefined,
    };
};

// ============================================
// GET MODERATION ITEM BY TARGET
// ============================================

export const getModerationItemByTarget = async (
    targetType: ModerationTarget,
    targetId: string
): Promise<ModerationItem | null> => {
    const result = await pool.query(
        `SELECT * FROM moderation_queue 
         WHERE target_type = $1 AND target_id = $2 
         ORDER BY created_at DESC LIMIT 1`,
        [targetType, targetId]
    );

    return result.rows.length > 0 ? mapRowToModerationItem(result.rows[0]) : null;
};

// ============================================
// REVIEW STORE (Approve or Reject)
// ============================================

export const reviewStore = async (
    storeId: string,
    moderatorId: string,
    approved: boolean,
    rejectionReason?: string,
    notes?: string
): Promise<{ store: any; moderationItem: ModerationItem }> => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const storeResult = await client.query(
            `SELECT * FROM stores WHERE id = $1 AND deleted_at IS NULL`,
            [storeId]
        );

        if (storeResult.rows.length === 0) {
            throw new AppError(404, 'Store not found.');
        }

        const store = storeResult.rows[0];

        if (store.status === StoreStatus.ACTIVE && store.is_approved) {
            throw new AppError(409, 'Store is already approved and active.');
        }

        if (store.status === StoreStatus.REJECTED) {
            throw new AppError(409, 'Store has already been rejected.');
        }

        let newStoreStatus: string;
        let newIsApproved: boolean;

        if (approved) {
            newStoreStatus = StoreStatus.ACTIVE;
            newIsApproved = true;
        } else {
            newStoreStatus = StoreStatus.REJECTED;
            newIsApproved = false;
        }

        await client.query(
            `UPDATE stores 
             SET status = $1,
                 is_approved = $2,
                 approved_at = $3,
                 approved_by = $4,
                 rejection_reason = $5,
                 published_at = CASE WHEN $1 = $6 THEN COALESCE(published_at, NOW()) ELSE published_at END,
                 updated_at = NOW()
             WHERE id = $7`,
            [
                newStoreStatus,
                newIsApproved,
                approved ? new Date() : null,
                approved ? moderatorId : null,
                approved ? null : (rejectionReason || 'Store rejected during moderation.'),
                StoreStatus.ACTIVE,
                storeId,
            ]
        );

        let moderationItemRow: any = null;
        const mqResult = await client.query(
            `UPDATE moderation_queue 
             SET status = $1,
                 moderated_by = $2,
                 moderated_at = NOW(),
                 notes = COALESCE($3, notes),
                 updated_at = NOW()
             WHERE target_type = 'store' AND target_id = $4
             RETURNING *`,
            [
                approved ? ModerationStatus.APPROVED : ModerationStatus.REJECTED,
                moderatorId,
                notes || null,
                storeId,
            ]
        );
        moderationItemRow = mqResult.rows[0] ?? null;

        if (!moderationItemRow) {
            moderationItemRow = {
                id: storeId,
                target_type: ModerationTarget.STORE,
                target_id: storeId,
                status: approved ? ModerationStatus.APPROVED : ModerationStatus.REJECTED,
                priority: ModerationPriority.MEDIUM,
                submitted_by: store.seller_id,
                submitted_at: store.created_at,
                moderated_by: moderatorId,
                moderated_at: new Date(),
                notes: notes || rejectionReason || null,
                metadata: null,
                created_at: store.created_at,
                updated_at: new Date(),
            };
        }

        await client.query(
            `INSERT INTO moderation_history (
                moderator_id, action, target_type, target_id,
                notes, metadata, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                moderatorId,
                approved ? 'store_approved' : 'store_rejected',
                ModerationTarget.STORE,
                storeId,
                notes || rejectionReason || null,
                JSON.stringify({
                    previous_status: store.status,
                    new_status: newStoreStatus,
                    rejection_reason: rejectionReason || null,
                    store_name: store.name,
                    seller_id: store.seller_id,
                }),
            ]
        );

        await client.query('COMMIT');

        const updatedStoreResult = await client.query(
            `SELECT * FROM stores WHERE id = $1`,
            [storeId]
        );

        return {
            store: updatedStoreResult.rows[0],
            moderationItem: mapRowToModerationItem(moderationItemRow),
        };

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

// ============================================
// UPDATE MODERATION STATUS
// ============================================

export const updateModerationStatus = async (
    id: string,
    moderatorId: string,
    action: ModerationAction,
    notes?: string
): Promise<ModerationItem> => {
    const statusMap: Record<ModerationAction, ModerationStatus> = {
        [ModerationAction.APPROVED]: ModerationStatus.APPROVED,
        [ModerationAction.REJECTED]: ModerationStatus.REJECTED,
        [ModerationAction.FLAGGED]: ModerationStatus.FLAGGED,
        [ModerationAction.SUSPENDED]: ModerationStatus.SUSPENDED,
        [ModerationAction.REMOVED]: ModerationStatus.REMOVED,
        [ModerationAction.RESOLVED]: ModerationStatus.RESOLVED,
    };

    const status = statusMap[action];

    const result = await pool.query(
        `UPDATE moderation_queue 
         SET status = $1,
             moderated_by = $2,
             moderated_at = NOW(),
             notes = COALESCE($3, notes),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [status, moderatorId, notes || null, id]
    );

    if (result.rows.length === 0) {
        throw new AppError(404, 'Moderation item not found.');
    }

    await pool.query(
        `INSERT INTO moderation_history (
            moderator_id, action, target_type, target_id, notes, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [moderatorId, action, result.rows[0].target_type, result.rows[0].target_id, notes || null]
    );

    return mapRowToModerationItem(result.rows[0]);
};

// ============================================
// GET MODERATION HISTORY
// ============================================

export const getModerationHistory = async (
    params: {
        moderatorId?: string;
        targetType?: string;
        action?: string;
        page?: number;
        limit?: number;
    } = {}
): Promise<{ items: ModerationHistoryEntry[]; pagination: any }> => {
    const {
        moderatorId,
        targetType,
        action,
        page = 1,
        limit = 20,
    } = params;

    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (moderatorId) {
        conditions.push(`mh.moderator_id = $${paramCount++}`);
        values.push(moderatorId);
    }

    if (targetType) {
        conditions.push(`mh.target_type = $${paramCount++}`);
        values.push(targetType);
    }

    if (action) {
        conditions.push(`mh.action = $${paramCount++}`);
        values.push(action);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
        `SELECT COUNT(*) FROM moderation_history mh ${whereClause}`,
        values
    );
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(
        `SELECT 
            mh.*,
            u.full_name  AS moderator_name,
            u.email      AS moderator_email,
            CASE mh.target_type
                WHEN 'product' THEN p.name
                WHEN 'store'   THEN s.name
                WHEN 'seller'  THEN sel.business_name
                WHEN 'review'  THEN COALESCE(pr.title, sr.title)
                ELSE NULL
            END AS target_name
        FROM moderation_history mh
        LEFT JOIN users           u   ON u.id  = mh.moderator_id
        LEFT JOIN products        p   ON mh.target_type = 'product' AND p.id  = mh.target_id
        LEFT JOIN stores          s   ON mh.target_type = 'store'   AND s.id  = mh.target_id
        LEFT JOIN sellers         sel ON mh.target_type = 'seller'  AND sel.id = mh.target_id
        LEFT JOIN product_reviews pr  ON mh.target_type = 'review'  AND pr.id  = mh.target_id
        LEFT JOIN store_reviews   sr  ON mh.target_type = 'review'  AND sr.id  = mh.target_id
        ${whereClause}
        ORDER BY mh.created_at DESC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
        [...values, limit, offset]
    );

    const items = result.rows.map(mapRowToHistoryEntry);

    return {
        items,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        },
    };
};

// ============================================
// BULK MODERATION
// ============================================

export const bulkModerateItems = async (
    targetType: ModerationTarget,
    targetIds: string[],
    moderatorId: string,
    action: ModerationAction,
    notes?: string
): Promise<BulkModerationResult> => {
    const errors: { id: string; error: string }[] = [];
    let processed = 0;

    for (const targetId of targetIds) {
        try {
            const moderationItem = await getModerationItemByTarget(targetType, targetId);

            if (!moderationItem) {
                await createModerationItem(
                    targetType,
                    targetId,
                    moderatorId,
                    ModerationPriority.MEDIUM
                );
            }

            await updateModerationStatus(
                moderationItem?.id || '',
                moderatorId,
                action,
                notes
            );

            if (targetType === ModerationTarget.STORE) {
                const isApproved = action === ModerationAction.APPROVED;
                await reviewStore(
                    targetId,
                    moderatorId,
                    isApproved,
                    isApproved ? undefined : notes,
                    notes
                );
            }

            processed++;
        } catch (error) {
            errors.push({
                id: targetId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }

    return {
        success: errors.length === 0,
        processed,
        failed: errors.length,
        errors,
    };
};

// ============================================
// UPDATE MODERATION PRIORITY
// ============================================

export const updateModerationPriority = async (
    itemId: string,
    priority: ModerationPriority
): Promise<ModerationItem> => {
    const result = await pool.query(
        `UPDATE moderation_queue 
         SET priority = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [priority, itemId]
    );

    if (result.rows.length === 0) {
        throw new AppError(404, 'Moderation item not found.');
    }

    return mapRowToModerationItem(result.rows[0]);
};

// ============================================
// ASSIGN MODERATOR TO ITEM
// ============================================

export const assignModeratorToItem = async (
    itemId: string,
    moderatorId: string
): Promise<ModerationItem> => {
    const result = await pool.query(
        `UPDATE moderation_queue 
         SET status = 'in_review',
             moderated_by = $1,
             updated_at = NOW()
         WHERE id = $2 AND status = 'pending'
         RETURNING *`,
        [moderatorId, itemId]
    );

    if (result.rows.length === 0) {
        throw new AppError(404, 'Moderation item not found or already in review.');
    }

    return mapRowToModerationItem(result.rows[0]);
};

// ============================================
// GET MODERATION DASHBOARD DATA
// ============================================

export const getModerationDashboard = async () => {
    const [stats, queue, history] = await Promise.all([
        getModerationStats(),
        getModerationQueueSummary(),
        getModerationHistory({ limit: 10 }),
    ]);

    const performance = {
        reviews_today: stats.today_pending || 0,
        reviews_this_week: stats.this_week_pending || 0,
        avg_response_time: stats.response_time_avg || 0,
        approval_rate: stats.total_reviewed > 0 ? (stats.approved / stats.total_reviewed) * 100 : 0,
    };

    const alerts: any[] = [];

    if (stats.pending > 50) {
        alerts.push({
            type: 'warning',
            message: `There are ${stats.pending} items pending moderation.`,
            action: { label: 'Review Queue', url: '/moderator/queue' },
        });
    }

    if (stats.today_pending > 20) {
        alerts.push({
            type: 'info',
            message: `You have ${stats.today_pending} new items to review today.`,
        });
    }

    if (stats.response_time_avg > 48) {
        alerts.push({
            type: 'error',
            message: `Average response time is ${Math.round(stats.response_time_avg)} hours. Consider reviewing the queue.`,
            action: { label: 'View Queue', url: '/moderator/queue' },
        });
    }

    return {
        stats,
        queue,
        recent_activity: history.items.slice(0, 10),
        performance,
        alerts,
    };
};

// ============================================
// PRODUCT MODERATION FUNCTIONS
// ============================================

/**
 * Get pending products for moderation.
 *
 * ✅ FIX: Now joins `product_images` and aggregates them into the
 * `product.images` array so the moderator UI can render thumbnails
 * and the hero image. Previously this returned no images at all.
 */
export const getPendingProductsForModeration = async (
    page: number = 1,
    limit: number = DEFAULT_LIMIT,
    search?: string
): Promise<{ items: any[]; total: number; pages: number }> => {
    const offset = (page - 1) * limit;
    const conditions: string[] = [
        'mq.target_type = $1',
        'mq.status = $2',
        'p.deleted_at IS NULL',
    ];
    const values: any[] = [ModerationTarget.PRODUCT, ModerationStatus.PENDING];
    let paramCount = 3;

    if (search) {
        conditions.push(`(p.name ILIKE $${paramCount} OR sb.business_name ILIKE $${paramCount})`);
        values.push(`%${search}%`);
        paramCount++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countQuery = `
        SELECT COUNT(DISTINCT mq.id) as total
        FROM moderation_queue mq
        JOIN products p ON p.id = mq.target_id
        JOIN stores st ON st.id = p.store_id
        JOIN sellers sb ON sb.id = p.seller_id
        ${whereClause}
    `;
    const countResult = await pool.query(countQuery, values);
    const total = parseInt(countResult.rows[0]?.total || '0');

    const query = `
        SELECT 
            mq.*,
            jsonb_build_object(
                'id', p.id,
                'name', p.name,
                'slug', p.slug,
                'description', p.description,
                'short_description', p.short_description,
                'price', p.price,
                'compare_at_price', p.compare_at_price,
                'sku', p.sku,
                'type', p.type,
                'condition', p.condition,
                'tags', p.tags,
                'stock_quantity', p.stock_quantity,
                'category_id', p.category_id,
                'store_id', p.store_id,
                'status', p.status,
                'is_active', p.is_active,
                'is_approved', p.is_approved,
                'created_at', p.created_at,
                'updated_at', p.updated_at,
                'images', COALESCE(
                    (
                        SELECT jsonb_agg(
                            jsonb_build_object(
                                'id', pi.id,
                                'product_id', pi.product_id,
                                'url', pi.url,
                                'public_id', pi.public_id,
                                'alt_text', pi.alt_text,
                                'is_primary', pi.is_primary,
                                'sort_order', pi.sort_order,
                                'metadata', pi.metadata,
                                'created_at', pi.created_at
                            )
                            ORDER BY pi.is_primary DESC, pi.sort_order ASC
                        )
                        FROM product_images pi
                        WHERE pi.product_id = p.id
                    ),
                    '[]'::jsonb
                )
            ) as product,
            jsonb_build_object(
                'id', st.id,
                'name', st.name,
                'slug', st.slug,
                'seller_id', st.seller_id
            ) as store,
            jsonb_build_object(
                'id', sb.id,
                'business_name', sb.business_name,
                'user', jsonb_build_object(
                    'id', u.id,
                    'full_name', u.full_name,
                    'email', u.email
                )
            ) as seller
        FROM moderation_queue mq
        JOIN products p ON p.id = mq.target_id
        JOIN stores st ON st.id = p.store_id
        JOIN sellers sb ON sb.id = p.seller_id
        JOIN users u ON u.id = sb.user_id
        ${whereClause}
        ORDER BY 
            CASE mq.priority 
                WHEN 'urgent' THEN 1 
                WHEN 'high' THEN 2 
                WHEN 'medium' THEN 3 
                WHEN 'low' THEN 4 
            END ASC,
            mq.created_at ASC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;
    values.push(limit, offset);

    const result = await pool.query(query, values);

    return {
        items: result.rows,
        total,
        pages: Math.ceil(total / limit),
    };
};

/**
 * Get product review details.
 *
 * ✅ FIX: Images now come from the `product_images` table instead of
 * the hardcoded empty array. Same aggregation as the list endpoint.
 */
export const getProductReviewDetails = async (productId: string): Promise<any> => {
    const result = await pool.query(
        `SELECT 
            p.*,
            c.name as category_name,
            st.id as store_id,
            st.name as store_name,
            st.slug as store_slug,
            sb.id as seller_id,
            sb.business_name,
            u.id as user_id,
            u.full_name,
            u.email,
            (
                SELECT COUNT(*) FROM product_views WHERE product_id = p.id
            ) as views,
            (
                SELECT COUNT(*) FROM wishlists WHERE product_id = p.id
            ) as wishlist_count,
            (
                SELECT COUNT(*) FROM order_items WHERE product_id = p.id
            ) as order_count,
            p.average_rating,
            p.total_reviews,
            COALESCE(
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'id', pi.id,
                            'product_id', pi.product_id,
                            'url', pi.url,
                            'public_id', pi.public_id,
                            'alt_text', pi.alt_text,
                            'is_primary', pi.is_primary,
                            'sort_order', pi.sort_order,
                            'metadata', pi.metadata,
                            'created_at', pi.created_at
                        )
                        ORDER BY pi.is_primary DESC, pi.sort_order ASC
                    )
                    FROM product_images pi
                    WHERE pi.product_id = p.id
                ),
                '[]'::jsonb
            ) as images
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN stores st ON st.id = p.store_id
        LEFT JOIN sellers sb ON sb.id = p.seller_id
        LEFT JOIN users u ON u.id = sb.user_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [productId]
    );

    if (result.rows.length === 0) {
        throw new AppError(404, 'Product not found.');
    }

    const row = result.rows[0];

    const historyResult = await pool.query(
        `SELECT 
            mh.*,
            u.full_name as moderator_name,
            u.email as moderator_email
        FROM moderation_history mh
        LEFT JOIN users u ON u.id = mh.moderator_id
        WHERE mh.target_type = 'product' AND mh.target_id = $1
        ORDER BY mh.created_at DESC
        LIMIT 10`,
        [productId]
    );

    return {
        product: {
            id: row.id,
            name: row.name,
            slug: row.slug,
            description: row.description,
            short_description: row.short_description,
            price: row.price,
            compare_at_price: row.compare_at_price,
            sku: row.sku,
            type: row.type,
            condition: row.condition,
            tags: row.tags ?? [],
            stock_quantity: row.stock_quantity,
            images: Array.isArray(row.images) ? row.images : [],
            category_id: row.category_id,
            category_name: row.category_name,
            store_id: row.store_id,
            status: row.status,
            is_active: row.is_active,
            is_approved: row.is_approved,
            created_at: row.created_at,
            updated_at: row.updated_at,
        },
        store: {
            id: row.store_id,
            name: row.store_name,
            slug: row.store_slug,
            seller_id: row.seller_id,
        },
        seller: {
            id: row.seller_id,
            legal_business_name: row.business_name,
            business_name: row.business_name,
            user: {
                id: row.user_id,
                full_name: row.full_name,
                email: row.email,
            },
        },
        stats: {
            views: parseInt(row.views || '0'),
            wishlist_count: parseInt(row.wishlist_count || '0'),
            order_count: parseInt(row.order_count || '0'),
            average_rating: parseFloat(row.average_rating || '0'),
            total_reviews: parseInt(row.total_reviews || '0'),
        },
        review_history: historyResult.rows,
    };
};

/**
 * Review a product (approve or reject).
 *
 * Unchanged — the CHECK constraint logic already handled the lifecycle.
 */
export const reviewProduct = async (
    productId: string,
    moderatorId: string,
    approved: boolean,
    rejectionReason?: string,
    notes?: string
): Promise<{ product: any; moderationItem: ModerationItem }> => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const productResult = await client.query(
            `SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL`,
            [productId]
        );

        if (productResult.rows.length === 0) {
            throw new AppError(404, 'Product not found.');
        }

        const product = productResult.rows[0];

        if (product.is_approved && product.is_active) {
            throw new AppError(409, 'Product is already approved and active.');
        }

        const moderationItem = await getModerationItemByTarget(
            ModerationTarget.PRODUCT,
            productId
        );

        if (!moderationItem) {
            throw new AppError(404, 'No pending moderation request found for this product.');
        }

        if (moderationItem.status !== ModerationStatus.PENDING) {
            throw new AppError(409, `This product is already ${moderationItem.status}.`);
        }

        await client.query(
            `UPDATE products 
             SET is_approved = $1,
                 is_active = $1,
                 status = $2,
                 moderated_by = $3,
                 moderated_at = NOW(),
                 moderation_notes = $4,
                 rejection_reason = $5,
                 updated_at = NOW()
             WHERE id = $6`,
            [
                approved,
                approved ? 'active' : 'rejected',
                moderatorId,
                notes || null,
                approved ? null : (rejectionReason || 'Product rejected during moderation.'),
                productId,
            ]
        );

        const updatedModerationResult = await client.query(
            `UPDATE moderation_queue 
             SET status = $1,
                 moderated_by = $2,
                 moderated_at = NOW(),
                 notes = COALESCE($3, notes),
                 updated_at = NOW()
             WHERE id = $4
             RETURNING *`,
            [
                approved ? ModerationStatus.APPROVED : ModerationStatus.REJECTED,
                moderatorId,
                notes || null,
                moderationItem.id,
            ]
        );

        await client.query(
            `INSERT INTO moderation_history (
                moderator_id, action, target_type, target_id,
                notes, metadata, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                moderatorId,
                approved ? 'product_approved' : 'product_rejected',
                ModerationTarget.PRODUCT,
                productId,
                notes || rejectionReason || null,
                JSON.stringify({
                    previous_status: product.status,
                    product_name: product.name,
                    store_id: product.store_id,
                }),
            ]
        );

        await client.query('COMMIT');

        const updatedProductResult = await client.query(
            `SELECT * FROM products WHERE id = $1`,
            [productId]
        );

        return {
            product: updatedProductResult.rows[0],
            moderationItem: mapRowToModerationItem(updatedModerationResult.rows[0]),
        };

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};