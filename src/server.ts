import dotenv from 'dotenv';
dotenv.config();

import { buildApp } from './app.js';
import { db } from './infrastructure/database/db.js';
import { seedDatabase } from './infrastructure/database/seed.js';
import { networkPrinter } from './hardware/printer/NetworkPrinter.js';
import { holdAndFireEngine } from './modules/kds/HoldAndFireEngine.js';

async function bootstrap() {
  console.log('========================================================');
  console.log('  ENTERPRISE RMS - EDGE CORE NODE (FAZ 1 & FAZ 2)');
  console.log('  Local POS, KDS & Waiter Handheld Real-Time Engine');
  console.log('========================================================');

  // 1. Initialize Database & Run Migrations
  await db.initialize();

  // 2. Auto-seed if brand new database
  await seedDatabase();

  // 3. Start KDS Hold & Fire Scheduler
  holdAndFireEngine.start(2500);

  // 4. Build & start HTTP / WebSocket Server
  const app = await buildApp();
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  await app.listen({ port, host });
  console.log(`[Edge Server] POS, KDS & Hardware Service listening on http://${host}:${port}`);
  console.log(`[Edge Server] KDS Kiosk UI available at http://${host}:${port}/kds`);
  console.log(`[Edge Server] Waiter Terminal UI available at http://${host}:${port}/waiter`);
  console.log(`[Edge Server] WebSocket Gateway listening on ws://${host}:${port}/ws`);
  console.log(`[Edge Server] Database Mode: ${db.getMode()}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Edge Server] Received ${signal}. Shutting down gracefully...`);
    holdAndFireEngine.stop();
    networkPrinter.close();
    await app.close();
    await db.close();
    console.log('[Edge Server] Closed all connections. Exit.');
    process.exit(0);
  };


  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[Edge Server] Fatal bootstrap failure:', err);
  process.exit(1);
});
