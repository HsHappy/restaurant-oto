import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { waiterService } from './WaiterService.js';
import { db } from '../../infrastructure/database/db.js';

export const waiterRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // GET /api/v1/waiter/tables
  server.get('/tables', async (request, reply) => {
    const query = request.query as { branchId?: string };
    let branchId = query.branchId;

    if (!branchId) {
      const branchRes = await db.query(`SELECT id FROM branches LIMIT 1`);
      if (branchRes.rows.length === 0) return reply.code(404).send({ error: 'Branch not found' });
      branchId = branchRes.rows[0].id;
    }

    const tables = await waiterService.getTablesOverview(branchId!);
    return reply.send({ success: true, count: tables.length, data: tables });
  });

  // POST /api/v1/waiter/quick-order
  server.post('/quick-order', async (request, reply) => {
    const body = request.body as {
      tableId: string;
      waiterId?: string;
      items: Array<{
        productId: string;
        quantity: number;
        modifiers?: Array<{ name: string; extra_price: number }>;
        customerNotes?: string;
      }>;
      enablePacing?: boolean;
    };

    const waiterId = body.waiterId || '00000000-0000-0000-0000-000000000001';
    const result = await waiterService.quickOrder({
      tableId: body.tableId,
      waiterId,
      items: body.items,
      enablePacing: body.enablePacing,
    });

    return reply.code(201).send({
      success: true,
      message: `Order submitted and routed to KDS for Table ${result.tableNumber}`,
      data: result,
    });
  });

  // POST /api/v1/waiter/request-bill
  server.post('/request-bill', async (request, reply) => {
    const body = request.body as { tableId: string; actorId?: string };
    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';

    const updatedTable = await waiterService.requestBill(body.tableId, actorId);
    return reply.send({
      success: true,
      message: `Bill requested for Table ${updatedTable.table_number}`,
      data: updatedTable,
    });
  });

  // POST /api/v1/waiter/transfer-table
  server.post('/transfer-table', async (request, reply) => {
    const body = request.body as { sourceTableId: string; targetTableId: string; waiterId?: string };
    const waiterId = body.waiterId || '00000000-0000-0000-0000-000000000001';

    const result = await waiterService.transferTable(body.sourceTableId, body.targetTableId, waiterId);
    return reply.send({
      success: true,
      message: `Table transferred from ${result.sourceTable} to ${result.targetTable}`,
      data: result,
    });
  });
};
