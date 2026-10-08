import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { auditService } from './AuditService.js';
import { db } from '../../infrastructure/database/db.js';
import { AuditLog } from '../../core/domain/entities/index.js';

export const auditRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // GET /api/v1/audit/logs
  server.get('/logs', async (request, reply) => {
    const query = request.query as { branchId?: string; limit?: string };
    let branchId = query.branchId;

    if (!branchId) {
      const branchRes = await db.query(`SELECT id FROM branches LIMIT 1`);
      if (branchRes.rows.length === 0) {
        return reply.code(404).send({ error: 'No branch found' });
      }
      branchId = branchRes.rows[0].id;
    }

    const limit = parseInt(query.limit || '50', 10);
    const logs = await db.query<AuditLog>(
      `SELECT * FROM audit_logs WHERE branch_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [branchId, limit]
    );

    return reply.send({ success: true, count: logs.rows.length, data: logs.rows });
  });

  // GET /api/v1/audit/verify
  server.get('/verify', async (request, reply) => {
    const query = request.query as { branchId?: string };
    let branchId = query.branchId;

    if (!branchId) {
      const branchRes = await db.query(`SELECT id FROM branches LIMIT 1`);
      if (branchRes.rows.length === 0) {
        return reply.code(404).send({ error: 'No branch found' });
      }
      branchId = branchRes.rows[0].id;
    }

    const verification = await auditService.verifyAuditChain(branchId!);
    return reply.send({ success: true, verification });
  });
};
