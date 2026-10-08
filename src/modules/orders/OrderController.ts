import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { orderService } from './OrderService.js';
import { OrderType } from '../../core/domain/enums/index.js';
import { db } from '../../infrastructure/database/db.js';

export const orderRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // GET /api/v1/orders/menu (Helper to fetch menu items)
  server.get('/menu', async (_request, reply) => {
    const categories = await db.query(`SELECT * FROM categories ORDER BY sort_order ASC`);
    const products = await db.query(`SELECT * FROM products WHERE is_available = TRUE ORDER BY name ASC`);
    return reply.send({
      success: true,
      data: {
        categories: categories.rows,
        products: products.rows,
      },
    });
  });

  // POST /api/v1/orders
  server.post('/', async (request, reply) => {
    const body = request.body as {
      branchId?: string;
      waiterId?: string;
      tableId?: string;
      orderType?: OrderType;
    };

    let branchId = body.branchId;
    if (!branchId) {
      const branchRes = await db.query(`SELECT id FROM branches LIMIT 1`);
      branchId = branchRes.rows[0].id;
    }

    const waiterId = body.waiterId || '00000000-0000-0000-0000-000000000001';
    const order = await orderService.createOrder(branchId!, waiterId, body.tableId, body.orderType);

    return reply.code(201).send({ success: true, data: order });
  });

  // GET /api/v1/orders/:id
  server.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await orderService.getOrderById(id);
    return reply.send({ success: true, data: order });
  });

  // POST /api/v1/orders/:id/items
  server.post('/:id/items', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      productId: string;
      quantity: number;
      modifiers?: { name: string; extra_price: number }[];
      waiterId?: string;
    };

    const waiterId = body.waiterId || '00000000-0000-0000-0000-000000000001';
    const result = await orderService.addItemToOrder(
      id,
      {
        productId: body.productId,
        quantity: body.quantity || 1,
        modifiers: body.modifiers,
      },
      waiterId
    );

    return reply.code(201).send({ success: true, data: result });
  });

  // DELETE /api/v1/orders/:id/items/:itemId
  server.delete('/:id/items/:itemId', async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = request.body as {
      reason: string;
      wasteRecorded?: boolean;
      managerPin: string;
      actorId?: string;
    };

    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';
    const updatedOrder = await orderService.cancelItem(
      id,
      itemId,
      body.reason || 'Customer changed mind',
      body.wasteRecorded ?? false,
      body.managerPin,
      actorId
    );

    return reply.send({ success: true, data: updatedOrder });
  });

  // POST /api/v1/orders/:id/discount
  server.post('/:id/discount', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      discountType: 'PERCENT' | 'FIXED' | 'COMPLIMENTARY';
      amount: number;
      managerPin: string;
      itemId?: string;
      actorId?: string;
    };

    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';
    const updatedOrder = await orderService.applyDiscountOrComp(
      id,
      body.discountType,
      body.amount,
      body.managerPin,
      actorId,
      body.itemId
    );

    return reply.send({ success: true, data: updatedOrder });
  });

  // POST /api/v1/orders/:id/split
  server.post('/:id/split', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      type: 'BY_ITEM' | 'EQUAL' | 'CUSTOM_AMOUNT';
      payload: any;
      actorId?: string;
    };

    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';
    const result = await orderService.splitOrder(id, body.type, body.payload, actorId);

    return reply.send({ success: true, data: result });
  });
};
