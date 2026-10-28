import { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import pg, { type PoolClient } from 'pg';
import { config } from '../config.js';

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 3, name: 'persistent_media', sql: 'CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, designer_id TEXT NOT NULL REFERENCES designers(id) ON DELETE CASCADE, data_url TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_media_designer ON media(designer_id);' },
  {
    version: 1,
    name: 'init',
    sql: `
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS designers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_designers_name ON designers(name);

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      designer_id TEXT NOT NULL REFERENCES designers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT,
      last_visit TEXT,
      history_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_customers_designer ON customers(designer_id);
    CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(designer_id, name);

    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      designer_id TEXT NOT NULL REFERENCES designers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      length TEXT NOT NULL DEFAULT '',
      bang TEXT NOT NULL DEFAULT '',
      perm TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      ref_images TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_presets_designer ON presets(designer_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_presets_category ON presets(designer_id, category);

    CREATE TABLE IF NOT EXISTS consultation_records (
      id TEXT PRIMARY KEY,
      designer_id TEXT NOT NULL REFERENCES designers(id) ON DELETE CASCADE,
      customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
      customer_name TEXT NOT NULL,
      date TEXT NOT NULL,
      style_name TEXT NOT NULL DEFAULT '',
      views TEXT NOT NULL DEFAULT '{}',
      intent TEXT NOT NULL DEFAULT '',
      adjustments TEXT NOT NULL DEFAULT '[]',
      condition_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_records_designer ON consultation_records(designer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_records_customer ON consultation_records(customer_id, created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'ai_sessions_and_versions',
    sql: `
    CREATE TABLE ai_sessions (
      id TEXT PRIMARY KEY,
      designer_id TEXT NOT NULL REFERENCES designers(id),
      request_id TEXT NOT NULL,
      input_json TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(designer_id, request_id)
    );
    CREATE TABLE ai_versions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ai_sessions(id),
      request_id TEXT NOT NULL,
      version_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, request_id)
    );
    ALTER TABLE consultation_records ADD COLUMN ai_session_id TEXT REFERENCES ai_sessions(id);
    ALTER TABLE consultation_records ADD COLUMN selected_version_id TEXT REFERENCES ai_versions(id);
    `,
  },
];



// Both drivers expose the same asynchronous statement interface. Local SQLite
// remains available for development and the regression suite.
export interface DatabaseSync {
  prepare(sql: string): {
    get(...args: any[]): Promise<any>;
    all(...args: any[]): Promise<any[]>;
    run(...args: any[]): Promise<{ changes: number }>;
  };
  exec(sql: string): Promise<void>;
}

pg.types.setTypeParser(20, value => Number(value));
let sqlite: SQLiteDatabase | null = null;
let pool: pg.Pool | null = null;
let database: DatabaseSync | null = null;
let initialization: Promise<void> | null = null;

function postgresDb(client: pg.Pool | PoolClient): DatabaseSync {
  const query = (sql: string, args: any[] = []) => {
    let index = 0;
    const translated = sql.replace(/\?/g, () => '$' + (++index))
      .replace(/ORDER BY rowid/g, 'ORDER BY sequence_no');
    return client.query(translated, args);
  };
  return {
    prepare(sql) {
      return {
        get: async (...args) => (await query(sql, args)).rows[0],
        all: async (...args) => (await query(sql, args)).rows,
        run: async (...args) => ({ changes: (await query(sql, args)).rowCount ?? 0 }),
      };
    },
    exec: async sql => { await query(sql); },
  };
}

export function getDb(): DatabaseSync {
  if (database) return database;
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3,
      idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
    database = postgresDb(pool);
  } else {
    if (process.env.VERCEL) throw new Error('DATABASE_URL is required on Vercel.');
    if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    sqlite = new SQLiteDatabase(config.dbPath);
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    sqlite.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = new Set((sqlite.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map(row => row.version));
    for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue;
      sqlite.exec(m.sql);
      sqlite.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    }
    database = {
      prepare(sql) {
        return {
          get: async (...args) => sqlite!.prepare(sql).get(...args),
          all: async (...args) => sqlite!.prepare(sql).all(...args),
          run: async (...args) => ({ changes: Number(sqlite!.prepare(sql).run(...args).changes) }),
        };
      },
      exec: async sql => { sqlite!.exec(sql); },
    };
  }
  return database;
}

export async function initializeDatabase(): Promise<void> {
  getDb();
  if (!pool) return;
  if (!initialization) initialization = (async () => {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(781426001)');
      await client.query('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      const applied = new Set((await client.query('SELECT version FROM _migrations')).rows.map(row => row.version));
      for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
        if (applied.has(migration.version)) continue;
        const sql = migration.sql.replace(/PRAGMA foreign_keys = ON;/g, '')
          .replace(/strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/g, 'CURRENT_TIMESTAMP::text')
          .replace('CREATE TABLE ai_versions (', 'CREATE TABLE ai_versions (sequence_no BIGSERIAL UNIQUE,');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (version, name, applied_at) VALUES ($1, $2, $3)', [migration.version, migration.name, new Date().toISOString()]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  })().catch(error => { initialization = null; throw error; });
  await initialization;
}

// A dedicated connection keeps all statements in the same PostgreSQL transaction.
// SQLite transactions are serialized because async continuations may interleave.
let sqliteQueue: Promise<unknown> = Promise.resolve();
export async function transaction<T>(fn: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
  const db = getDb();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(postgresDb(client));
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const task = sqliteQueue.then(async () => {
    await db.exec('BEGIN IMMEDIATE');
    try { const result = await fn(db); await db.exec('COMMIT'); return result; }
    catch (error) { await db.exec('ROLLBACK'); throw error; }
  });
  sqliteQueue = task.catch(() => {});
  return task;
}

export async function closeDb(): Promise<void> {
  await sqliteQueue;
  sqlite?.close();
  await pool?.end();
  sqlite = null; pool = null; database = null; initialization = null;
}
