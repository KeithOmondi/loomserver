// src/services/audit.service.ts
import type { Request } from 'express';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../config/db';

type Queryable = Pool | PoolClient;

export interface AuditEvent {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Records who did what. Never throws: an audit failure must not break the action it describes. */
export const audit = async (event: AuditEvent, q: Queryable = pool): Promise<void> => {
  try {
    await q.query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, metadata, ip)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        event.actorId ?? null,
        event.actorRole ?? null,
        event.action,
        event.entityType ?? null,
        event.entityId ?? null,
        JSON.stringify(event.metadata ?? {}),
        event.ip ?? null,
      ],
    );
  } catch (err) {
    console.error('[audit] failed to record', event.action, (err as Error).message);
  }
};

/** Convenience: build an audit event from the authenticated request. */
export const auditFromReq = (
  req: Request,
  action: string,
  entityType?: string,
  entityId?: string,
  metadata?: Record<string, unknown>,
) =>
  audit({
    actorId: req.user?.id,
    actorRole: req.user?.role,
    action,
    entityType,
    entityId,
    metadata,
    ip: req.ip,
  });
