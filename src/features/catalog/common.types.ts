// src/features/catalog/common.types.ts

export type UUID = string;

export interface Timestamped {
  created_at: Date;
  updated_at: Date;
}

export interface Pagination {
  page: number;
  limit: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export type SortDirection = 'asc' | 'desc';

/** Store is its own entity — do not conflate with User. */
export interface StoreSummary {
  id: UUID;
  name: string;
  slug: string;
  logo_url: string | null;
  is_verified: boolean;
}