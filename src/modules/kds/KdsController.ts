import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { kdsService } from './KdsService.js';
import { holdAndFireEngine } from './HoldAndFireEngine.js';
import { PreparationStation } from '../../core/domain/enums/index.js';

export const kdsRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // GET /api/v1/kds/stations
  server.get('/stations', async (_request, reply) => {
    return reply.send({
      success: true,
      data: [
        { key: PreparationStation.EXPEDITOR, label: 'Şef / Tümü (Expeditor)' },
        { key: PreparationStation.GRILL, label: 'Izgara İstasyonu' },
        { key: PreparationStation.OVEN, label: 'Fırın & Pide İstasyonu' },
        { key: PreparationStation.COLD, label: 'Soğuk & Salata İstasyonu' },
        { key: PreparationStation.BAR, label: 'Bar & İçecek İstasyonu' },
      ],
    });
  });

  // GET /api/v1/kds/tickets
  server.get('/tickets', async (request, reply) => {
    const query = request.query as { station?: string };
    const station = (query.station as PreparationStation | 'EXPEDITOR') || 'EXPEDITOR';

    const tickets = await kdsService.getStationTickets(station);
    return reply.send({
      success: true,
      station,
      count: tickets.length,
      data: tickets,
    });
  });

  // POST /api/v1/kds/items/:id/bump
  server.post('/items/:id/bump', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { actorId?: string }) || {};
    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';

    await kdsService.bumpItem(id, actorId);
    return reply.send({ success: true, message: 'Item bumped to READY' });
  });

  // POST /api/v1/kds/items/:id/hold
  server.post('/items/:id/hold', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { actorId?: string }) || {};
    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';

    await kdsService.holdItem(id, actorId);
    return reply.send({ success: true, message: 'Item status set to HOLD' });
  });

  // POST /api/v1/kds/items/:id/fire
  server.post('/items/:id/fire', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { actorId?: string }) || {};
    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';

    await holdAndFireEngine.forceFire(id, actorId);
    return reply.send({ success: true, message: 'Item fired immediately to QUEUED' });
  });

  // POST /api/v1/kds/items/:id/serve
  server.post('/items/:id/serve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { waiterId?: string }) || {};
    const waiterId = body.waiterId || '00000000-0000-0000-0000-000000000001';

    await kdsService.serveItem(id, waiterId);
    return reply.send({ success: true, message: 'Item marked as SERVED' });
  });

  // POST /api/v1/kds/tickets/:orderId/bump
  server.post('/tickets/:orderId/bump', async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    const body = (request.body as { station?: PreparationStation | 'EXPEDITOR'; actorId?: string }) || {};
    const station = body.station || 'EXPEDITOR';
    const actorId = body.actorId || '00000000-0000-0000-0000-000000000001';

    await kdsService.bumpTicket(orderId, station, actorId);
    return reply.send({ success: true, message: 'Ticket bumped for station' });
  });

  // POST /api/v1/kds/recall
  server.post('/recall', async (request, reply) => {
    const body = (request.body as { station?: PreparationStation | 'EXPEDITOR' }) || {};
    const station = body.station || 'EXPEDITOR';

    const result = await kdsService.recallLastBump(station);
    return reply.send({
      success: result.recalled,
      message: result.recalled ? 'Last bumped item recalled to KDS' : 'No recent bump found to recall',
      data: result,
    });
  });
};
