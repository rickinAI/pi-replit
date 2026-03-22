import { getPool } from "./db.js";

export interface PipelineEventMetadata {
  inbox: string;
  category: string;
  sender_domain: string;
  classification_confidence: string;
  vault_written: boolean;
  vault_path: string | null;
  reject_reason: string | null;
  body_length: number;
  parsed_signals: any[];
}

export interface PipelineEvent {
  id?: number;
  inbox: string;
  category: string;
  sender: string;
  subject: string | null;
  status: "processed" | "rejected" | "error";
  metadata: PipelineEventMetadata;
  created_at: number;
}

export interface PipelineStats {
  by_inbox: Record<string, number>;
  by_category: Record<string, number>;
  total_24h: number;
  last_event_at: number | null;
}

export async function initPipelineTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_pipeline (
      id SERIAL PRIMARY KEY,
      inbox TEXT NOT NULL,
      category TEXT NOT NULL,
      sender TEXT NOT NULL,
      subject TEXT,
      status TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_pipeline_inbox ON email_pipeline(inbox)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_pipeline_created ON email_pipeline(created_at DESC)`);
}

function validateMetadataEnvelope(meta: any): PipelineEventMetadata {
  return {
    inbox: typeof meta.inbox === "string" ? meta.inbox : "unknown",
    category: typeof meta.category === "string" ? meta.category : "unrouted",
    sender_domain: typeof meta.sender_domain === "string" ? meta.sender_domain : "unknown",
    classification_confidence: typeof meta.classification_confidence === "string" ? meta.classification_confidence : "unknown",
    vault_written: typeof meta.vault_written === "boolean" ? meta.vault_written : false,
    vault_path: typeof meta.vault_path === "string" ? meta.vault_path : null,
    reject_reason: typeof meta.reject_reason === "string" ? meta.reject_reason : null,
    body_length: typeof meta.body_length === "number" ? meta.body_length : 0,
    parsed_signals: Array.isArray(meta.parsed_signals) ? meta.parsed_signals : [],
  };
}

export async function logPipelineEvent(event: PipelineEvent): Promise<number> {
  const pool = getPool();
  const validatedMeta = validateMetadataEnvelope(event.metadata);
  const result = await pool.query(
    `INSERT INTO email_pipeline (inbox, category, sender, subject, status, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      event.inbox,
      event.category,
      event.sender,
      event.subject,
      event.status,
      JSON.stringify(validatedMeta),
      event.created_at,
    ]
  );
  return result.rows[0].id;
}

export async function updatePipelineEvent(
  id: number,
  updates: Partial<Pick<PipelineEvent, "status" | "metadata">>
): Promise<void> {
  const pool = getPool();
  if (updates.metadata) {
    await pool.query(
      `UPDATE email_pipeline SET metadata = metadata || $1::jsonb WHERE id = $2`,
      [JSON.stringify(updates.metadata), id]
    );
  }
  if (updates.status) {
    await pool.query(
      `UPDATE email_pipeline SET status = $1 WHERE id = $2`,
      [updates.status, id]
    );
  }
}

export async function queryPipelineEvents(filters: {
  inbox?: string;
  category?: string;
  since?: number;
  limit?: number;
}): Promise<PipelineEvent[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (filters.inbox) {
    conditions.push(`inbox = $${paramIdx++}`);
    params.push(filters.inbox);
  }
  if (filters.category) {
    conditions.push(`category LIKE $${paramIdx++}`);
    params.push(`${filters.category}%`);
  }
  if (filters.since) {
    conditions.push(`created_at >= $${paramIdx++}`);
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(filters.limit || 20, 100));

  const result = await pool.query(
    `SELECT id, inbox, category, sender, subject, status, metadata, created_at
     FROM email_pipeline ${where}
     ORDER BY created_at DESC
     LIMIT ${limit}`,
    params
  );

  return result.rows.map(r => ({
    id: r.id,
    inbox: r.inbox,
    category: r.category,
    sender: r.sender,
    subject: r.subject,
    status: r.status,
    metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata,
    created_at: Number(r.created_at),
  }));
}

export async function getPipelineStats(): Promise<PipelineStats> {
  const pool = getPool();
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const [byInbox, byCategory, total24h, lastEvent] = await Promise.all([
    pool.query(`SELECT inbox, COUNT(*)::int as count FROM email_pipeline GROUP BY inbox`),
    pool.query(`SELECT category, COUNT(*)::int as count FROM email_pipeline GROUP BY category ORDER BY count DESC LIMIT 20`),
    pool.query(`SELECT COUNT(*)::int as count FROM email_pipeline WHERE created_at >= $1`, [oneDayAgo]),
    pool.query(`SELECT MAX(created_at) as last_at FROM email_pipeline`),
  ]);

  const byInboxMap: Record<string, number> = {};
  for (const r of byInbox.rows) byInboxMap[r.inbox] = r.count;

  const byCategoryMap: Record<string, number> = {};
  for (const r of byCategory.rows) byCategoryMap[r.category] = r.count;

  return {
    by_inbox: byInboxMap,
    by_category: byCategoryMap,
    total_24h: total24h.rows[0]?.count || 0,
    last_event_at: lastEvent.rows[0]?.last_at ? Number(lastEvent.rows[0].last_at) : null,
  };
}

export async function pruneOldEvents(olderThanDays: number = 30): Promise<number> {
  const pool = getPool();
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = await pool.query(
    `DELETE FROM email_pipeline WHERE created_at < $1`,
    [cutoff]
  );
  const deleted = result.rowCount || 0;
  if (deleted > 0) {
    console.log(`[pipeline-store] Pruned ${deleted} events older than ${olderThanDays} days`);
  }
  return deleted;
}
