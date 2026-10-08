import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { tableService } from './TableService.js';
import { TableStatus } from '../../core/domain/enums/index.js';
import { db } from '../../infrastructure/database/db.js';

export const tableRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // GET /api/v1/tables
  server.get('/', async (request, reply) => {
    const query = request.query as { branchId?: string };
    let branchId = query.branchId;

    if (!branchId) {
      const branchRes = await db.query(`SELECT id FROM branches LIMIT 1`);
      if (branchRes.rows.length === 0) {
        return reply.code(404).send({ error: 'No branch found' });
      }
      branchId = branchRes.rows[0].id;
    }

    const tables = await tableService.getTables(branchId!);
    return reply.send({ success: true, count: tables.length, data: tables });
  });

  // GET /api/v1/tables/:id
  server.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const table = await tableService.getTableById(id);
    return reply.send({ success: true, data: table });
  });

  // POST /api/v1/tables/:id/open
  server.post('/:id/open', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { waiterId?: string }) || {};
    const waiterId = body.waiterId || '00000000-0000-0000-0000-000000000001';

    const result = await tableService.openTable(id, waiterId);
    return reply.code(201).send({
      success: true,
      message: `Table opened successfully`,
      data: result,
    });
  });

  // PATCH /api/v1/tables/:id/status
  server.patch('/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status: TableStatus; actorId?: string };
    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';

    const updated = await tableService.updateStatus(id, body.status, actorId);
    return reply.send({ success: true, data: updated });
  });

  // POST /api/v1/tables/:id/lock
  server.post('/:id/lock', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { lockedBy: string };
    const locked = await tableService.acquireLock(id, body.lockedBy);
    return reply.send({ success: true, data: locked });
  });

  // POST /api/v1/tables/:id/unlock
  server.post('/:id/unlock', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { lockedBy?: string }) || {};
    await tableService.releaseLock(id, body.lockedBy);
    return reply.send({ success: true, message: 'Lock released' });
  });
};
