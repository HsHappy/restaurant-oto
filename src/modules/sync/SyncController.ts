import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { syncEngine, CloudCatalogUpdate } from './SyncEngine.js';

export async function syncRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Trigger Manual Outbox Event Push to Cloud (Upstream)
   */
  fastify.post('/push', async (request: FastifyRequest, reply: FastifyReply) => {
    const { batchSize } = (request.body || {}) as { batchSize?: number };
    const result = await syncEngine.pushLocalEvents(batchSize || 50);

    return reply.send({
      success: true,
      result,
    });
  });

  /**
   * Pull Cloud Catalog/Pricing updates into Edge Node (Downstream)
   */
  fastify.post('/pull', async (request: FastifyRequest, reply: FastifyReply) => {
    const { updates } = request.body as { updates: CloudCatalogUpdate[] };

    if (!updates || !Array.isArray(updates)) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid request: "updates" array is required.',
      });
    }

    const result = await syncEngine.pullCloudUpdates(updates);

    return reply.send({
      success: true,
      message: 'Cloud updates pulled and merged with local state',
      result,
    });
  });

  /**
   * Toggle Network Online/Offline state for offline resilience testing
   */
  fastify.post('/network-mode', async (request: FastifyRequest, reply: FastifyReply) => {
    const { isOnline } = request.body as { isOnline: boolean };

    if (typeof isOnline !== 'boolean') {
      return reply.code(400).send({
        success: false,
        message: 'Boolean flag "isOnline" is required.',
      });
    }

    syncEngine.networkMonitor.setOnline(isOnline);

    return reply.send({
      success: true,
      message: `Edge network state set to ${isOnline ? 'ONLINE' : 'OFFLINE'}`,
      isOnline,
    });
  });

  /**
   * Get overall sync status, pending outbox queue length, and network state
   */
  fastify.get('/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const status = await syncEngine.getSyncStatus();
    return reply.send({
      success: true,
      status,
    });
  });

  /**
   * Get stock discrepancy & negative stock tolerance alerts
   */
  fastify.get('/stock-discrepancies', async (_request: FastifyRequest, reply: FastifyReply) => {
    const alerts = await syncEngine.checkStockDiscrepancies();
    return reply.send({
      success: true,
      ...alerts,
    });
  });
}
