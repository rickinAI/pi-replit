import pg from "pg";

let pool: pg.Pool | null = null;

export async function init(): Promise<pg.Pool> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("[db] DATABASE_URL not set");
  }
  pool = new pg.Pool({ connectionString, max: 10 });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New conversation',
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      synced_at BIGINT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      completed BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      tags JSONB DEFAULT '[]'::jsonb
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at BIGINT NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      service TEXT PRIMARY KEY,
      tokens JSONB NOT NULL,
      updated_at BIGINT NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_history (
      id SERIAL PRIMARY KEY,
      job_id TEXT NOT NULL,
      job_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      summary TEXT,
      saved_to TEXT,
      duration_ms INTEGER,
      agent_id TEXT,
      model_used TEXT,
      tokens_input INTEGER,
      tokens_output INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_history_created ON job_history(created_at DESC)`);
  await pool.query(`ALTER TABLE job_history ADD COLUMN IF NOT EXISTS agent_id TEXT`);
  await pool.query(`ALTER TABLE job_history ADD COLUMN IF NOT EXISTS model_used TEXT`);
  await pool.query(`ALTER TABLE job_history ADD COLUMN IF NOT EXISTS tokens_input INTEGER`);
  await pool.query(`ALTER TABLE job_history ADD COLUMN IF NOT EXISTS tokens_output INTEGER`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_history_agent_created ON job_history(agent_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_history_job_created ON job_history(job_id, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_activity (
      id SERIAL PRIMARY KEY,
      agent TEXT NOT NULL,
      task TEXT,
      conversation_id TEXT,
      conversation_title TEXT,
      duration_ms INTEGER,
      saved_to TEXT,
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_activity_created ON agent_activity(created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_inbox (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      file_path TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      summary TEXT,
      source TEXT DEFAULT 'drop-box',
      status TEXT NOT NULL DEFAULT 'processing',
      error TEXT,
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vault_inbox_created ON vault_inbox(created_at DESC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_inbox_url ON vault_inbox(url)`);

  console.log("[db] PostgreSQL initialized (shared pool, 7 tables)");
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("[db] Not initialized — call init() first");
  return pool;
}
