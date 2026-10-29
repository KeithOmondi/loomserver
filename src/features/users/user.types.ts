// src/types/user.types.ts
import { UserRole } from '../../middlewares/auth.middleware';

// ============================================
// Core User Types
// ============================================

export interface User {
    id: string;
    email: string;
    password_hash: string;
    full_name: string;
    role: UserRole;
    store_id: string | null;
    is_active: boolean;
    token_version: number;

    // Avatar fields
    avatar_url?: string | null;
    avatar_public_id?: string | null;

    // Contact
    phone?: string | null;
    phone_verified?: boolean;

    // Audit
    created_at: Date;
    updated_at: Date;
}

// AuthUser = User without password_hash (used for auth)
export type AuthUser = Omit<User, 'password_hash'>;

// SafeUser = User without sensitive data (used for API responses)
export type SafeUser = Omit<User, 'password_hash' | 'token_version'>;

// ============================================
// User Registration Types
// ============================================

export interface CreateUserInput {
    email: string;
    password: string;
    full_name: string;
    role: Exclude<UserRole, 'super_admin' | 'admin'>; // Customer or Seller only
    phone?: string;
    is_active?: boolean; // Optional, defaults to false for self-registration
}

export interface CreateAdminUserInput {
    email: string;
    password: string;
    full_name: string;
    role: 'moderator' | 'admin' | 'super_admin';
    phone?: string;
    is_active?: boolean; // ✅ NEW: Defaults to true for admin-created accounts
}

// ============================================
// User Update Types
// ============================================

export interface UpdateUserInput {
    full_name?: string;
    email?: string;
    phone?: string | null;
    avatar_url?: string | null;
    avatar_public_id?: string | null;
}

export interface AdminUpdateUserInput {
    full_name?: string;
    email?: string;
    role?: 'moderator' | 'admin' | 'super_admin';
    is_active?: boolean;
}

// ============================================
// Password Types
// ============================================

export interface UpdatePasswordInput {
    currentPassword: string;
    newPassword: string;
    confirmPassword?: string;
}

export interface UpdatePasswordResult {
    success: boolean;
    message: string;
}

// ============================================
// Password Reset Types (First Login)
// ============================================

// src/types/user.types.ts

export interface FirstLoginPasswordResetInput {
    email: string;
    temporaryPassword: string;
    newPassword: string;
    confirmPassword: string; // ✅ Required for validation
}

export interface FirstLoginPasswordResetResult {
    success: boolean;
    message: string;
}

// ============================================
// Avatar Types
// ============================================

export interface AvatarUploadInput {
    file: Express.Multer.File;
    userId: string;
}

export interface AvatarUploadResult {
    url: string;
    publicId: string;
    format: string;
    width: number;
    height: number;
}

export interface AvatarDeleteResult {
    success: boolean;
    message: string;
}

export interface UpdateUserWithAvatarInput extends UpdateUserInput {
    avatar_file?: Express.Multer.File;
    remove_avatar?: boolean;
}

// ============================================
// User Profile Types
// ============================================

export interface UserProfile extends SafeUser {}

export interface UserProfileResponse {
    success: boolean;
    user: UserProfile;
}

// ============================================
// User List Types (Admin)
// ============================================

export interface UserListFilters {
    page?: number;
    limit?: number;
    role?: UserRole;
    search?: string;
    is_active?: boolean;
    sortBy?: 'created_at' | 'full_name' | 'email' | 'role';
    sortOrder?: 'asc' | 'desc';
}

export interface UserListResponse {
    success: boolean;
    data: UserProfile[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        pages: number;
    };
}

// ============================================
// User Statistics Types (Admin)
// ============================================

export interface UserStatistics {
    total_users: number;
    customers: number;
    sellers: number;
    moderators: number;
    admins: number;
    super_admins: number;
    active_users: number;
    inactive_users: number;
}

export interface UserStatisticsResponse {
    success: boolean;
    data: UserStatistics;
}

// ============================================
// Role-based Types
// ============================================

export interface RoleInfo {
    role: UserRole;
    displayName: string;
    description: string;
    permissions: string[];
    color: string;
    badgeClass: string;
    redirectPath: string;
}

export const ROLE_INFO: Record<UserRole, RoleInfo> = {
    customer: {
        role: 'customer',
        displayName: 'Customer',
        description: 'Can browse and purchase products',
        permissions: ['browse', 'purchase', 'review'],
        color: 'text-gray-600',
        badgeClass: 'bg-gray-100 text-gray-700',
        redirectPath: '/',
    },
    seller: {
        role: 'seller',
        displayName: 'Seller',
        description: 'Can manage store, products, and orders',
        permissions: ['browse', 'purchase', 'review', 'manage_store', 'manage_products', 'manage_orders'],
        color: 'text-blue-600',
        badgeClass: 'bg-blue-100 text-blue-700',
        redirectPath: '/dashboard',
    },
    moderator: {
        role: 'moderator',
        displayName: 'Moderator',
        description: 'Can review stores, products, and moderate content',
        permissions: ['browse', 'review_stores', 'review_products', 'moderate_content', 'view_all'],
        color: 'text-purple-600',
        badgeClass: 'bg-purple-100 text-purple-700',
        redirectPath: '/moderator/dashboard',
    },
    admin: {
        role: 'admin',
        displayName: 'Administrator',
        description: 'Can manage users, platform settings, and view reports',
        permissions: ['browse', 'review_stores', 'review_products', 'moderate_content', 'view_all', 'manage_users', 'manage_settings'],
        color: 'text-red-600',
        badgeClass: 'bg-red-100 text-red-700',
        redirectPath: '/admin/dashboard',
    },
    super_admin: {
        role: 'super_admin',
        displayName: 'Super Administrator',
        description: 'Full system access, can manage roles and all settings',
        permissions: ['browse', 'review_stores', 'review_products', 'moderate_content', 'view_all', 'manage_users', 'manage_settings', 'manage_roles'],
        color: 'text-amber-600',
        badgeClass: 'bg-amber-100 text-amber-700',
        redirectPath: '/super-admin/dashboard',
    },
};

// ============================================
// Role Permission Helpers
// ============================================

export const hasPermission = (user: User | null, permission: string): boolean => {
    if (!user) return false;
    const roleInfo = ROLE_INFO[user.role as UserRole];
    if (!roleInfo) return false;
    return roleInfo.permissions.includes(permission);
};

export const hasAnyPermission = (user: User | null, permissions: string[]): boolean => {
    if (!user) return false;
    return permissions.some((p) => hasPermission(user, p));
};

export const hasAllPermissions = (user: User | null, permissions: string[]): boolean => {
    if (!user) return false;
    return permissions.every((p) => hasPermission(user, p));
};

export const isRoleOrHigher = (user: User | null, requiredRole: UserRole): boolean => {
    if (!user) return false;

    const roleHierarchy: Record<UserRole, number> = {
        customer: 0,
        seller: 1,
        moderator: 2,
        admin: 3,
        super_admin: 4,
    };

    const userRank = roleHierarchy[user.role] ?? -1;
    const requiredRank = roleHierarchy[requiredRole] ?? -1;

    return userRank >= requiredRank;
};

export const isCustomer = (user: User | null): boolean => user?.role === 'customer';
export const isSeller = (user: User | null): boolean => user?.role === 'seller';
export const isModerator = (user: User | null): boolean => user?.role === 'moderator';
export const isAdmin = (user: User | null): boolean => user?.role === 'admin';
export const isSuperAdmin = (user: User | null): boolean => user?.role === 'super_admin';

export const isModeratorOrHigher = (user: User | null): boolean => isRoleOrHigher(user, 'moderator');
export const isAdminOrHigher = (user: User | null): boolean => isRoleOrHigher(user, 'admin');

export const getRoleDisplayName = (role: UserRole): string => ROLE_INFO[role]?.displayName || role;
export const getRoleColor = (role: UserRole): string => ROLE_INFO[role]?.color || 'text-gray-600';
export const getRoleBadgeClass = (role: UserRole): string => ROLE_INFO[role]?.badgeClass || 'bg-gray-100 text-gray-700';
export const getRoleRedirectPath = (role: UserRole): string => ROLE_INFO[role]?.redirectPath || '/';

// ============================================
// Cloudinary Types
// ============================================

export interface CloudinaryConfig {
    cloud_name: string;
    api_key: string;
    api_secret: string;
    upload_folder?: string;
    allowed_formats?: string[];
    max_file_size?: number;
    transformation?: {
        width?: number;
        height?: number;
        crop?: string;
        quality?: number;
    };
}

export interface AvatarValidation {
    maxSize: number;
    allowedFormats: string[];
    maxWidth?: number;
    maxHeight?: number;
    minWidth?: number;
    minHeight?: number;
}

export const AVATAR_VALIDATION: AvatarValidation = {
    maxSize: 5 * 1024 * 1024, // 5MB
    allowedFormats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
    maxWidth: 2000,
    maxHeight: 2000,
    minWidth: 100,
    minHeight: 100,
};

// ============================================
// First Login Types
// ============================================

export interface FirstLoginCheckResponse {
    success: boolean;
    data: {
        isFirstLogin: boolean;
        needsPasswordReset: boolean;
    };
}

// ============================================
// Seller Types (Deprecated - use seller.types.ts)
// ============================================

/**
 * @deprecated These seller fields have been moved to the sellers table.
 * Use the seller.types.ts file instead.
 */
export type BusinessType = 'sole_proprietorship' | 'llc' | 'corporation' | 'partnership';
export type VerificationStatus = 'pending' | 'verified' | 'rejected';

/**
 * @deprecated Use seller.types.ts instead
 */
export interface SellerVerificationInput {
    legal_name: string;
    date_of_birth: Date;
    country: string;
    phone: string;
    business_name: string;
    business_type?: BusinessType;
    tax_id?: string;
    government_id_url?: string;
}

/**
 * @deprecated Use seller.types.ts instead
 */
export interface SellerVerificationStatus {
    verification_status: VerificationStatus;
    rejection_reason?: string | null;
    verified_at?: Date | null;
}

// ============================================
// API Response Types
// ============================================

export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    message?: string;
    errors?: string[];
}

export interface UserResponse {
    success: boolean;
    user: SafeUser;
}

export interface UsersResponse {
    success: boolean;
    users: SafeUser[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        pages: number;
    };
}