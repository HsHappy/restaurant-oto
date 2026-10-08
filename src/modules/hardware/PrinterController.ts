import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { printerService } from '../../hardware/printer/PrinterService.js';
import { networkPrinter } from '../../hardware/printer/NetworkPrinter.js';
import { orderService } from '../orders/OrderService.js';
import { db } from '../../infrastructure/database/db.js';
import { Branch } from '../../core/domain/entities/index.js';
import { auditService } from '../audit/AuditService.js';
import { InvalidManagerPinError } from '../../core/domain/errors/DomainError.js';

export const printerRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // POST /api/v1/printer/receipt
  server.post('/receipt', async (request, reply) => {
    const body = request.body as {
      orderId: string;
      openDrawer?: boolean;
      host?: string;
      port?: number;
    };

    const order = await orderService.getOrderById(body.orderId);
    const branchRes = await db.query<Branch>(`SELECT * FROM branches WHERE id = $1`, [order.branch_id]);
    const branch = branchRes.rows[0];

    const result = await printerService.printReceipt(order, branch, {
      openDrawer: body.openDrawer,
      host: body.host,
      port: body.port,
    });

    return reply.send({
      success: result.success || result.queued,
      jobId: result.jobId,
      queued: result.queued,
      message: result.message,
    });
  });

  // POST /api/v1/printer/kitchen
  server.post('/kitchen', async (request, reply) => {
    const body = request.body as {
      orderId: string;
      station?: string;
      host?: string;
      port?: number;
    };

    const order = await orderService.getOrderById(body.orderId);
    const station = body.station || 'GRILL';
    const items = (order.items || []).filter(
      (it: any) => !body.station || it.preparation_station === body.station
    );

    const result = await printerService.printKitchenTicket(
      station,
      order.table_number || 'Paket',
      order.waiter_id,
      items.length > 0 ? items : order.items || [],
      order.order_number,
      { host: body.host, port: body.port }
    );

    return reply.send({
      success: result.success || result.queued,
      jobId: result.jobId,
      queued: result.queued,
      message: result.message,
    });
  });

  // POST /api/v1/printer/drawer
  server.post('/drawer', async (request, reply) => {
    const body = (request.body as { managerPin?: string; actorId?: string }) || {};
    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';

    // Verify Manager PIN for manual drawer open (anti-theft policy in spec 5.3)
    const requiredPin = process.env.MANAGER_PIN || '1234';
    if (!body.managerPin || body.managerPin !== requiredPin) {
      throw new InvalidManagerPinError();
    }

    const branchRes = await db.query(`SELECT id FROM branches LIMIT 1`);
    const branchId = branchRes.rows[0]?.id;

    const result = await printerService.openCashDrawer();

    if (branchId) {
      await auditService.log({
        branchId,
        actorId,
        entityName: 'CASH_DRAWER',
        entityId: '00000000-0000-0000-0000-000000000000',
        actionType: 'MANUAL_DRAWER_KICK',
        reason: 'Manual cash drawer kick triggered by manager authorization',
      });
    }

    return reply.send({
      success: result.success || result.queued,
      jobId: result.jobId,
      queued: result.queued,
      message: result.message,
    });
  });

  // GET /api/v1/printer/queue
  server.get('/queue', async (_request, reply) => {
    const queue = networkPrinter.getQueue();
    return reply.send({
      success: true,
      queueLength: queue.length,
      queue: queue.map((j) => ({
        id: j.id,
        type: j.type,
        target: `${j.targetHost}:${j.targetPort}`,
        attempts: j.attempts,
        createdAt: j.createdAt,
      })),
    });
  });
};
