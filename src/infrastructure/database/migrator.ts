import { db } from './db.js';

async function main() {
  console.log('[Migrator] Starting migration...');
  await db.initialize();
  await db.runMigrations();
  console.log('[Migrator] Database migration complete.');
  await db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[Migrator] Migration failed:', err);
  process.exit(1);
});
