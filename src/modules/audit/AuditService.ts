import { createHash, randomUUID } from 'node:crypto';
import { db, IDbClient } from '../../infrastructure/database/db.js';
import { AuditLog } from '../../core/domain/entities/index.js';

export interface CreateAuditEntryInput {
  branchId: string;
  actorId: string;
  entityName: string;
  entityId: string;
  actionType: string;
  beforeState?: any;
  afterState?: any;
  reason?: string;
  ipAddress?: string;
}

export class AuditService {
  private static GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

  /**
   * Canonical JSON stringifier that sorts object keys recursively
   */
  public static canonicalize(obj: any): string {
    if (obj === null || obj === undefined) return '';
    if (typeof obj !== 'object') return String(obj);
    if (Array.isArray(obj)) {
      return '[' + obj.map(AuditService.canonicalize).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => `"${k}":${AuditService.canonicalize(obj[k])}`).join(',') + '}';
  }

  /**
   * Deterministic hash computer
   */
  public static computeHash(
    id: string,
    timestampIso: string,
    actorId: string,
    actionType: string,
    entityName: string,
    entityId: string,
    beforeState: any,
    afterState: any,
    reason: string | null | undefined,
    previousHash: string
  ): string {
    const payload = `${entityName}|${entityId}|${AuditService.canonicalize(beforeState)}|${AuditService.canonicalize(afterState)}|${reason || ''}`;
    const hashInput = `${id}|${timestampIso}|${actorId}|${actionType}|${payload}|${previousHash}`;
    return createHash('sha256').update(hashInput).digest('hex');
  }

  /**
   * Appends an immutable, SHA-256 cryptographically chained audit log entry.
   */
  public async log(input: CreateAuditEntryInput, client: IDbClient = db): Promise<AuditLog> {
    const id = randomUUID();
    // Normalize timestamp to whole seconds or millisecond ISO string
    const now = new Date();
    // Ensure clean ISO string with millisecond precision
    const timestampIso = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();

    // 1. Get previous record's current_hash to chain
    const prevRes = await client.query<{ current_hash: string }>(
      `SELECT current_hash FROM audit_logs WHERE branch_id = $1 ORDER BY sequence_num DESC LIMIT 1`,
      [input.branchId]
    );

    const previousHash = prevRes.rows.length > 0 ? prevRes.rows[0].current_hash : AuditService.GENESIS_HASH;

    // 2. Compute canonical SHA-256 current_hash
    const currentHash = AuditService.computeHash(
      id,
      timestampIso,
      input.actorId,
      input.actionType,
      input.entityName,
      input.entityId,
      input.beforeState,
      input.afterState,
      input.reason,
      previousHash
    );

    // 3. Insert into audit_logs table
    await client.query(
      `INSERT INTO audit_logs (
        id, branch_id, actor_id, entity_name, entity_id, action_type,
        before_state, after_state, reason, ip_address, previous_hash, current_hash, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        input.branchId,
        input.actorId,
        input.entityName,
        input.entityId,
        input.actionType,
        input.beforeState ? JSON.stringify(input.beforeState) : null,
        input.afterState ? JSON.stringify(input.afterState) : null,
        input.reason || null,
        input.ipAddress || null,
        previousHash,
        currentHash,
        timestampIso,
      ]
    );

    // 4. Also register into outbox_events for cloud synchronization
    await client.query(
      `INSERT INTO outbox_events (
        id, aggregate_type, aggregate_id, event_type, payload, status, retry_count, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        input.entityName,
        input.entityId,
        `AUDIT.${input.actionType}`,
        JSON.stringify({
          auditId: id,
          actorId: input.actorId,
          actionType: input.actionType,
          currentHash,
          previousHash,
          createdAt: timestampIso,
        }),
        'PENDING',
        0,
        timestampIso,
      ]
    );

    return {
      id,
      branch_id: input.branchId,
      actor_id: input.actorId,
      entity_name: input.entityName,
      entity_id: input.entityId,
      action_type: input.actionType,
      before_state: input.beforeState,
      after_state: input.afterState,
      reason: input.reason,
      ip_address: input.ipAddress,
      previous_hash: previousHash,
      current_hash: currentHash,
      created_at: new Date(timestampIso),
    };
  }

  /**
   * Verifies the cryptographic integrity of the entire audit chain for a branch.
   */
  public async verifyAuditChain(branchId: string): Promise<{ valid: boolean; brokenAtIndex?: number; message?: string }> {
    const res = await db.query<AuditLog>(
      `SELECT * FROM audit_logs WHERE branch_id = $1 ORDER BY sequence_num ASC`,
      [branchId]
    );

    const logs = res.rows;
    if (logs.length === 0) {
      return { valid: true, message: 'No audit records present' };
    }

    let expectedPrevHash = AuditService.GENESIS_HASH;

    for (let i = 0; i < logs.length; i++) {
      const entry = logs[i];

      // Check linkage
      if (entry.previous_hash !== expectedPrevHash) {
        return {
          valid: false,
          brokenAtIndex: i,
          message: `Linkage broken at log ${entry.id}. Expected previous hash ${expectedPrevHash}, got ${entry.previous_hash}`,
        };
      }

      // Format timestamp back to exact ISO string
      const timestampIso = new Date(entry.created_at).toISOString();

      // Parse JSON fields if string or keep object
      const beforeState = typeof entry.before_state === 'string' ? JSON.parse(entry.before_state) : entry.before_state;
      const afterState = typeof entry.after_state === 'string' ? JSON.parse(entry.after_state) : entry.after_state;

      const recalculated = AuditService.computeHash(
        entry.id,
        timestampIso,
        entry.actor_id,
        entry.action_type,
        entry.entity_name,
        entry.entity_id,
        beforeState,
        afterState,
        entry.reason,
        expectedPrevHash
      );

      if (recalculated !== entry.current_hash) {
        return {
          valid: false,
          brokenAtIndex: i,
          message: `Hash mismatch at log ${entry.id}. Calculated ${recalculated}, stored ${entry.current_hash}`,
        };
      }

      expectedPrevHash = entry.current_hash;
    }

    return { valid: true, message: `All ${logs.length} audit chain entries cryptographically verified.` };
  }
}

export const auditService = new AuditService();
