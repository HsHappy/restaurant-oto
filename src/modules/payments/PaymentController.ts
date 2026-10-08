import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { paymentService } from './PaymentService.js';
import { PaymentMethod } from '../../core/domain/enums/index.js';

export const paymentRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // POST /api/v1/payments
  server.post('/', async (request, reply) => {
    const body = request.body as {
      orderId: string;
      method: PaymentMethod;
      amount: number;
      actorId?: string;
      transactionReference?: string;
    };

    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';
    const result = await paymentService.processPayment({
      orderId: body.orderId,
      method: body.method,
      amount: body.amount,
      actorId,
      transactionReference: body.transactionReference,
    });

    return reply.code(201).send({
      success: true,
      message: result.isFullySettled ? 'Order paid in full and settled' : 'Partial payment processed',
      data: result,
    });
  });

  // GET /api/v1/payments/order/:orderId
  server.get('/order/:orderId', async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    const payments = await paymentService.getPaymentsForOrder(orderId);
    return reply.send({ success: true, count: payments.length, data: payments });
  });
};
