import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { posTerminalService } from './PosTerminalService.js';
import { virtualPosService, CardPaymentInput } from './VirtualPosService.js';
import { TerminalSaleRequest } from '../../core/domain/entities/index.js';

export async function posTerminalRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Execute Card Sale on physical POS terminal
   */
  fastify.post('/sale', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as TerminalSaleRequest;

    if (!body.orderId || !body.amount || body.amount <= 0) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid request: orderId and positive amount are required.',
      });
    }

    const result = await posTerminalService.chargeOrderViaTerminal(body);

    return reply.code(201).send({
      success: true,
      message: 'Card payment approved by POS terminal (00)',
      result,
    });
  });

  /**
   * Execute Settlement (Gün Sonu Mutabakatı) on POS terminal
   */
  fastify.post('/settlement', async (request: FastifyRequest, reply: FastifyReply) => {
    const { terminalId } = (request.body || {}) as { terminalId?: string };
    const result = await posTerminalService.executeSettlement(terminalId);

    return reply.send({
      success: true,
      message: 'POS terminal settlement completed successfully',
      settlement: result,
    });
  });

  /**
   * Create Virtual POS session for table QR payment
   */
  fastify.post('/virtual-pos/session', async (request: FastifyRequest, reply: FastifyReply) => {
    const { orderId, amount, currency } = request.body as {
      orderId: string;
      amount: number;
      currency?: string;
    };

    if (!orderId || !amount || amount <= 0) {
      return reply.code(400).send({
        success: false,
        message: 'orderId and amount are required.',
      });
    }

    const session = virtualPosService.createSession(orderId, amount, currency);

    return reply.code(201).send({
      success: true,
      session,
    });
  });

  /**
   * Process Virtual POS 3D Secure charge
   */
  fastify.post('/virtual-pos/charge', async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId, card } = request.body as {
      sessionId: string;
      card: CardPaymentInput;
    };

    if (!sessionId || !card) {
      return reply.code(400).send({
        success: false,
        message: 'sessionId and card details are required.',
      });
    }

    const chargeResult = await virtualPosService.processCharge(sessionId, card);

    // Apply payment to order in database
    const session = virtualPosService.getSession(sessionId);
    if (session) {
      await posTerminalService.chargeOrderViaTerminal({
        orderId: session.orderId,
        amount: session.amount,
        currency: session.currency,
        terminalId: 'VPOS-WEB-01',
      });
    }

    return reply.send({
      success: true,
      message: 'Virtual POS charge completed successfully',
      chargeResult,
    });
  });

  /**
   * Get POS Terminal audit logs
   */
  fastify.get('/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { limit?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const logs = await posTerminalService.getTerminalLogs(limit);

    return reply.send({
      success: true,
      count: logs.length,
      logs,
    });
  });
}
