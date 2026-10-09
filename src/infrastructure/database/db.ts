import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface IDbClient {
  query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
}

class DatabaseManager implements IDbClient {
  private pgPool: pg.Pool | null = null;
  private pglite: PGlite | null = null;
  private mode: 'POSTGRES' | 'PGLITE' = 'PGLITE';
  private initialized = false;

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    const databaseUrl = process.env.DATABASE_URL;

    // Try connecting to PostgreSQL first if DATABASE_URL is configured
    if (databaseUrl && !databaseUrl.startsWith('memory') && !databaseUrl.startsWith('pglite')) {
      try {
        const pool = new pg.Pool({
          connectionString: databaseUrl,
          connectionTimeoutMillis: 2000,
        });

        // Test connection
        const client = await pool.connect();
        client.release();

        this.pgPool = pool;
        this.mode = 'POSTGRES';
        this.initialized = true;
        console.log(`[DatabaseManager] Connected to PostgreSQL 16 at ${databaseUrl.replace(/:[^:@]+@/, ':****@')}`);
        await this.runMigrations();
        return;
      } catch (err: any) {
        console.warn(`[DatabaseManager] PostgreSQL connection failed (${err.message}). Falling back to Embedded PostgreSQL 16 (PGlite)...`);
      }
    }

    // Fallback or explicit PGlite
    try {
      this.pglite = new PGlite();
      this.mode = 'PGLITE';
      this.initialized = true;
      console.log('[DatabaseManager] Initialized Embedded PostgreSQL 16 (PGlite WASM) engine.');
      await this.runMigrations();
    } catch (err: any) {
      console.error('[DatabaseManager] Fatal: Could not initialize database engine:', err);
      throw err;
    }
  }

  public getMode(): 'POSTGRES' | 'PGLITE' {
    return this.mode;
  }

  public async query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.mode === 'POSTGRES' && this.pgPool) {
      const res = await this.pgPool.query(text, params);
      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? res.rows.length,
      };
    }

    if (this.mode === 'PGLITE' && this.pglite) {
      const res = await this.pglite.query(text, params);
      return {
        rows: res.rows as T[],
        rowCount: res.rows.length,
      };
    }

    throw new Error('DatabaseManager is not initialized');
  }

  public async transaction<T>(fn: (client: IDbClient) => Promise<T>): Promise<T> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.mode === 'POSTGRES' && this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        const dbAdapter: IDbClient = {
          query: async <R = any>(text: string, params?: any[]) => {
            const res = await client.query(text, params);
            return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
          },
        };
        const result = await fn(dbAdapter);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    if (this.mode === 'PGLITE' && this.pglite) {
      return await this.pglite.transaction(async (tx) => {
        const dbAdapter: IDbClient = {
          query: async <R = any>(text: string, params?: any[]) => {
            const res = await tx.query(text, params);
            return { rows: res.rows as R[], rowCount: res.rows.length };
          },
        };
        return await fn(dbAdapter);
      });
    }

    throw new Error('DatabaseManager is not initialized');
  }

  public async runMigrations(): Promise<void> {
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      console.warn(`[DatabaseManager] Migrations directory not found at ${migrationsDir}`);
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    console.log(`[DatabaseManager] Applying ${files.length} database migration(s)...`);

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      console.log(`[DatabaseManager] Executing migration: ${file}`);

      if (this.mode === 'PGLITE' && this.pglite) {
        await this.pglite.exec(sql);
      } else if (this.mode === 'POSTGRES' && this.pgPool) {
        await this.pgPool.query(sql);
      }
    }

    console.log('[DatabaseManager] All migrations applied successfully.');
  }


  public async close(): Promise<void> {
    if (this.pgPool) {
      await this.pgPool.end();
      this.pgPool = null;
    }
    if (this.pglite) {
      await this.pglite.close();
      this.pglite = null;
    }
    this.initialized = false;
  }
}

export const db = new DatabaseManager();
