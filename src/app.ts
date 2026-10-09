import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { DomainError } from './core/domain/errors/DomainError.js';
import { tableRoutes } from './modules/tables/TableController.js';
import { orderRoutes } from './modules/orders/OrderController.js';
import { paymentRoutes } from './modules/payments/PaymentController.js';
import { printerRoutes } from './modules/hardware/PrinterController.js';
import { auditRoutes } from './modules/audit/AuditController.js';
import { kdsRoutes } from './modules/kds/KdsController.js';
import { waiterRoutes } from './modules/waiter/WaiterController.js';
import { wsGateway } from './infrastructure/websocket/WebSocketGateway.js';
import { db } from './infrastructure/database/db.js';
import { networkPrinter } from './hardware/printer/NetworkPrinter.js';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // CORS
  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // WebSockets
  await app.register(websocket);

  app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (connection /* SocketStream */) => {
      wsGateway.registerClient(connection);
    });
  });

  // Health check & Edge node status
  app.get('/health', async (_request, reply) => {
    return reply.send({
      status: 'UP',
      edgeNode: 'ONLINE',
      timestamp: new Date().toISOString(),
      databaseMode: db.getMode(),
      connectedClients: wsGateway.getConnectedClientsCount(),
      printerQueueLength: networkPrinter.getQueueLength(),
    });
  });

  // Serve Frontend Clients (KDS & Waiter Handheld)
  const clientDir = path.resolve(process.cwd(), 'client');
  if (fs.existsSync(clientDir)) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: '/client/',
    });

    app.get('/kds', async (_req, reply) => {
      return reply.sendFile('kds/index.html');
    });

    app.get('/waiter', async (_req, reply) => {
      return reply.sendFile('waiter/index.html');
    });
  }

  // API v1 Routes
  await app.register(tableRoutes, { prefix: '/api/v1/tables' });
  await app.register(orderRoutes, { prefix: '/api/v1/orders' });
  await app.register(paymentRoutes, { prefix: '/api/v1/payments' });
  await app.register(printerRoutes, { prefix: '/api/v1/printer' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit' });
  await app.register(kdsRoutes, { prefix: '/api/v1/kds' });
  await app.register(waiterRoutes, { prefix: '/api/v1/waiter' });


  // Centralized Error Handler
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({
        success: false,
        error: error.name,
        message: error.message,
      });
    }

    app.log.error(error);
    return reply.code(error.statusCode || 500).send({
      success: false,
      error: error.name || 'InternalServerError',
      message: error.message || 'An unexpected error occurred',
    });
  });


  return app;
}
