import crypto from "crypto";
import pg from "pg";

const EMBEDDING_DIM = 768;
const CHUNK_MAX_CHARS = 1500;
const BATCH_SIZE = 20;
const DEFAULT_EXCLUDED_FOLDERS = ["Ops/Daily Digests", "Ops", "Archive"];

function getExcludedFolders(): string[] {
  const envExclusions = process.env.VAULT_EXCLUDE_FOLDERS;
  if (envExclusions) {
    return envExclusions.split(",").map(f => f.trim()).filter(Boolean);
  }
  return DEFAULT_EXCLUDED_FOLDERS;
}

export interface VaultOps {
  listRecursive: (path: string) => Promise<string>;
  read: (path: string) => Promise<string>;
}

let pool: pg.Pool | null = null;
let vaultOps: VaultOps | null = null;
let indexingInProgress = false;
let lastIndexRun: { timestamp: number; filesIndexed: number; errors: number } | null = null;

export function init(dbPool: pg.Pool, ops: VaultOps) {
  pool = dbPool;
  vaultOps = ops;
}

export function isConfigured(): boolean {
  return !!(pool && vaultOps && getEmbeddingProvider());
}

export function getStatus() {
  return {
    configured: isConfigured(),
    provider: getEmbeddingProvider(),
    indexing: indexingInProgress,
    lastRun: lastIndexRun,
  };
}

function getEmbeddingProvider(): "cloudflare" | "openai" | null {
  if (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) return "cloudflare";
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) return "cloudflare";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

function hasOpenAIFallback(): boolean {
  return !!process.env.OPENAI_API_KEY;
}


export async function ensureTable(): Promise<void> {
  if (!pool) throw new Error("[vault-embeddings] Not initialized");

  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_embeddings (
      id SERIAL PRIMARY KEY,
      file_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      embedding vector(${EMBEDDING_DIM}),
      chunk_text TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(file_path, chunk_index)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vault_emb_file ON vault_embeddings(file_path)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vault_emb_hash ON vault_embeddings(content_hash)`);

  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vault_emb_vec ON vault_embeddings USING hnsw (embedding vector_cosine_ops)`);
  } catch (err) {
    console.warn("[vault-embeddings] HNSW index creation failed (may already exist or need more data):", err);
  }
}

async function callProviderWithRetry(
  providerFn: (texts: string[]) => Promise<number[][]>,
  texts: string[],
  providerName: string,
  retries = 2
): Promise<number[][]> {
  try {
    return await providerFn(texts);
  } catch (err: any) {
    if (retries > 0 && (err.message?.includes("429") || err.message?.includes("500") || err.message?.includes("502") || err.message?.includes("503"))) {
      const delay = (3 - retries) * 2000;
      console.warn(`[vault-embeddings] ${providerName} error, retrying in ${delay}ms (${retries} left): ${err.message?.slice(0, 100)}`);
      await new Promise(r => setTimeout(r, delay));
      return callProviderWithRetry(providerFn, texts, providerName, retries - 1);
    }
    throw err;
  }
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const provider = getEmbeddingProvider();
  if (!provider) throw new Error("[vault-embeddings] No embedding provider configured");

  if (provider === "cloudflare") {
    try {
      return await callProviderWithRetry(embedCloudflare, texts, "Cloudflare");
    } catch (cfErr: any) {
      if (hasOpenAIFallback()) {
        console.warn(`[vault-embeddings] Cloudflare failed, falling back to OpenAI: ${cfErr.message?.slice(0, 100)}`);
        return await callProviderWithRetry(embedOpenAI, texts, "OpenAI");
      }
      throw cfErr;
    }
  } else {
    return await callProviderWithRetry(embedOpenAI, texts, "OpenAI");
  }
}

async function embedCloudflare(texts: string[]): Promise<number[][]> {
  const accountId = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-base-en-v1.5`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Cloudflare embedding API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  if (!data.result?.data) {
    throw new Error(`Cloudflare embedding: unexpected response shape`);
  }
  return data.result.data;
}

async function embedOpenAI(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
      dimensions: EMBEDDING_DIM,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI embedding API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  return data.data.map((d: any) => d.embedding);
}

function hashContent(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function chunkByHeading(content: string, filePath: string): Array<{ text: string; metadata: Record<string, any> }> {
  const chunks: Array<{ text: string; metadata: Record<string, any> }> = [];
  const lines = content.split("\n");
  let currentChunk = "";
  let currentHeading = "";

  function pushChunk() {
    const trimmed = currentChunk.trim();
    if (trimmed.length < 20) return;
    if (trimmed.length <= CHUNK_MAX_CHARS) {
      chunks.push({
        text: trimmed,
        metadata: { heading: currentHeading, file: filePath },
      });
    } else {
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      let buf = "";
      for (const s of sentences) {
        if (buf.length + s.length > CHUNK_MAX_CHARS && buf.length > 0) {
          chunks.push({
            text: buf.trim(),
            metadata: { heading: currentHeading, file: filePath },
          });
          buf = "";
        }
        buf += (buf ? " " : "") + s;
      }
      if (buf.trim().length >= 20) {
        chunks.push({
          text: buf.trim(),
          metadata: { heading: currentHeading, file: filePath },
        });
      }
    }
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      pushChunk();
      currentHeading = headingMatch[2].trim();
      currentChunk = line + "\n";
    } else {
      currentChunk += line + "\n";
    }
  }
  pushChunk();

  if (chunks.length === 0 && content.trim().length >= 20) {
    chunks.push({
      text: content.trim().slice(0, CHUNK_MAX_CHARS),
      metadata: { heading: "", file: filePath },
    });
  }

  return chunks;
}

function isExcluded(filePath: string): boolean {
  const excluded = getExcludedFolders();
  const parts = filePath.split("/");
  return parts.some(p => excluded.some(ex => p.toLowerCase() === ex.toLowerCase()));
}

async function getAllVaultFiles(): Promise<string[]> {
  if (!vaultOps) throw new Error("[vault-embeddings] Vault ops not initialized");

  const data = await vaultOps.listRecursive("/");
  const parsed = JSON.parse(data);
  const allFiles: string[] = parsed.files || [];

  return allFiles
    .filter((f: string) => !f.endsWith("/") && f.endsWith(".md"))
    .filter((f: string) => !isExcluded(f));
}

export async function indexVault(forceReindex = false): Promise<{ indexed: number; skipped: number; errors: number; total: number }> {
  if (!pool || !vaultOps) throw new Error("[vault-embeddings] Not initialized");
  if (!getEmbeddingProvider()) throw new Error("[vault-embeddings] No embedding provider configured");
  if (indexingInProgress) return { indexed: 0, skipped: 0, errors: 0, total: 0 };

  indexingInProgress = true;
  const startTime = Date.now();
  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  try {
    let files: string[];
    try {
      files = await getAllVaultFiles();
    } catch (err) {
      console.warn("[vault-embeddings] Could not list vault files — vault may be unavailable:", err);
      return { indexed: 0, skipped: 0, errors: 0, total: 0 };
    }
    console.log(`[vault-embeddings] Starting index: ${files.length} vault files found (force=${forceReindex})`);

    if (forceReindex) {
      await pool.query("DELETE FROM vault_embeddings");
      console.log("[vault-embeddings] Cleared existing embeddings for full re-index");
    }

    const existingHashes = new Map<string, Map<number, string>>();
    if (!forceReindex) {
      const existing = await pool.query("SELECT file_path, chunk_index, content_hash FROM vault_embeddings");
      for (const row of existing.rows) {
        if (!existingHashes.has(row.file_path)) existingHashes.set(row.file_path, new Map());
        existingHashes.get(row.file_path)!.set(row.chunk_index, row.content_hash);
      }
    }

    const existingFiles = new Set<string>();
    const pendingEmbeddings: Array<{ filePath: string; chunkIndex: number; text: string; hash: string; metadata: Record<string, any> }> = [];

    for (const relPath of files) {
      existingFiles.add(relPath);
      try {
        const content = await vaultOps.read(relPath);
        const chunks = chunkByHeading(content, relPath);

        const fileHashes = existingHashes.get(relPath);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const hash = hashContent(chunk.text);

          if (fileHashes && fileHashes.get(i) === hash) {
            skipped++;
            continue;
          }

          pendingEmbeddings.push({
            filePath: relPath,
            chunkIndex: i,
            text: chunk.text,
            hash,
            metadata: chunk.metadata,
          });
        }

        if (fileHashes) {
          const maxExisting = Math.max(...Array.from(fileHashes.keys()));
          if (maxExisting >= chunks.length) {
            await pool.query(
              "DELETE FROM vault_embeddings WHERE file_path = $1 AND chunk_index >= $2",
              [relPath, chunks.length]
            );
          }
        }
      } catch (err) {
        errors++;
        console.error(`[vault-embeddings] Error processing ${relPath}:`, err);
      }
    }

    if (!forceReindex) {
      const allIndexedPaths = await pool.query("SELECT DISTINCT file_path FROM vault_embeddings");
      for (const row of allIndexedPaths.rows) {
        if (!existingFiles.has(row.file_path)) {
          await pool.query("DELETE FROM vault_embeddings WHERE file_path = $1", [row.file_path]);
        }
      }
    }

    for (let batchStart = 0; batchStart < pendingEmbeddings.length; batchStart += BATCH_SIZE) {
      const batch = pendingEmbeddings.slice(batchStart, batchStart + BATCH_SIZE);
      try {
        const texts = batch.map(b => b.text);
        const embeddings = await embedTexts(texts);

        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];
          const embedding = embeddings[i];
          const vecStr = `[${embedding.join(",")}]`;

          await pool.query(
            `INSERT INTO vault_embeddings (file_path, chunk_index, content_hash, embedding, chunk_text, metadata, updated_at)
             VALUES ($1, $2, $3, $4::vector, $5, $6, NOW())
             ON CONFLICT (file_path, chunk_index) DO UPDATE SET
               content_hash = EXCLUDED.content_hash,
               embedding = EXCLUDED.embedding,
               chunk_text = EXCLUDED.chunk_text,
               metadata = EXCLUDED.metadata,
               updated_at = NOW()`,
            [item.filePath, item.chunkIndex, item.hash, vecStr, item.text, JSON.stringify(item.metadata)]
          );
          indexed++;
        }
      } catch (err) {
        errors += batch.length;
        console.error(`[vault-embeddings] Batch embedding error (batch ${batchStart / BATCH_SIZE + 1}):`, err);
      }
    }

    const duration = Date.now() - startTime;
    lastIndexRun = { timestamp: Date.now(), filesIndexed: indexed, errors };
    console.log(`[vault-embeddings] Index complete: ${indexed} indexed, ${skipped} skipped, ${errors} errors in ${duration}ms`);

    return { indexed, skipped, errors, total: files.length };
  } finally {
    indexingInProgress = false;
  }
}

export async function semanticSearch(
  query: string,
  topK = 10,
  folderFilter?: string
): Promise<Array<{ filePath: string; chunkIndex: number; similarity: number; excerpt: string; heading: string }>> {
  if (!pool) throw new Error("[vault-embeddings] Not initialized");
  if (!getEmbeddingProvider()) throw new Error("[vault-embeddings] No embedding provider configured");
  topK = Math.max(1, topK);

  const [queryEmbedding] = await embedTexts([query]);
  const vecStr = `[${queryEmbedding.join(",")}]`;

  let sql: string;
  let params: any[];

  if (folderFilter) {
    sql = `
      SELECT file_path, chunk_index, chunk_text, metadata,
             1 - (embedding <=> $1::vector) AS similarity
      FROM vault_embeddings
      WHERE file_path LIKE $3
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `;
    params = [vecStr, topK, `${folderFilter}%`];
  } else {
    sql = `
      SELECT file_path, chunk_index, chunk_text, metadata,
             1 - (embedding <=> $1::vector) AS similarity
      FROM vault_embeddings
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `;
    params = [vecStr, topK];
  }

  const result = await pool.query(sql, params);

  return result.rows.map(row => ({
    filePath: row.file_path,
    chunkIndex: row.chunk_index,
    similarity: parseFloat(row.similarity),
    excerpt: row.chunk_text.slice(0, 500),
    heading: row.metadata?.heading || "",
  }));
}

export async function getSemanticNeighbors(
  filePath: string,
  topK = 10
): Promise<Array<{ filePath: string; chunkIndex: number; similarity: number; excerpt: string }>> {
  if (!pool) throw new Error("[vault-embeddings] Not initialized");
  topK = Math.max(1, topK);

  const fileChunks = await pool.query(
    "SELECT embedding FROM vault_embeddings WHERE file_path = $1 ORDER BY chunk_index",
    [filePath]
  );

  if (fileChunks.rows.length === 0) {
    throw new Error(`No embeddings found for: ${filePath}`);
  }

  const avgResult = await pool.query(
    `SELECT AVG(embedding)::vector AS avg_embedding
     FROM vault_embeddings WHERE file_path = $1`,
    [filePath]
  );
  const avgEmbedding = avgResult.rows[0]?.avg_embedding || fileChunks.rows[0].embedding;

  const result = await pool.query(
    `SELECT file_path, chunk_index, chunk_text,
            1 - (embedding <=> $1::vector) AS similarity
     FROM vault_embeddings
     WHERE file_path != $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [avgEmbedding, filePath, topK]
  );

  return result.rows.map(row => ({
    filePath: row.file_path,
    chunkIndex: row.chunk_index,
    similarity: parseFloat(row.similarity),
    excerpt: row.chunk_text.slice(0, 500),
  }));
}

export async function getOrphanedNotes(): Promise<string[]> {
  if (!pool || !vaultOps) throw new Error("[vault-embeddings] Not initialized");

  const semanticIsolated = await pool.query(`
    SELECT DISTINCT a.file_path, a.chunk_text
    FROM vault_embeddings a
    WHERE a.chunk_index = 0
    AND NOT EXISTS (
      SELECT 1 FROM vault_embeddings b
      WHERE b.file_path != a.file_path
      AND 1 - (a.embedding <=> b.embedding) > 0.75
    )
    ORDER BY a.file_path
  `);

  const orphaned: string[] = [];
  const wikilinkRegex = /\[\[([^\]]+)\]\]/g;

  for (const row of semanticIsolated.rows) {
    try {
      const content = await vaultOps.read(row.file_path);
      const hasWikilinks = wikilinkRegex.test(content);
      wikilinkRegex.lastIndex = 0;
      if (!hasWikilinks) {
        orphaned.push(row.file_path);
      }
    } catch {
      orphaned.push(row.file_path);
    }
  }

  return orphaned;
}

export async function getTopClusters(
  clusterCount = 5
): Promise<Array<{ theme: string; files: string[] }>> {
  if (!pool) throw new Error("[vault-embeddings] Not initialized");

  const result = await pool.query(`
    SELECT a.file_path AS file_a, b.file_path AS file_b,
           1 - (a.embedding <=> b.embedding) AS similarity
    FROM vault_embeddings a
    JOIN vault_embeddings b ON a.id < b.id AND a.file_path != b.file_path
    WHERE a.chunk_index = 0 AND b.chunk_index = 0
    ORDER BY a.embedding <=> b.embedding
    LIMIT 50
  `);

  const clusterMap = new Map<string, Set<string>>();
  for (const row of result.rows) {
    if (parseFloat(row.similarity) < 0.7) continue;
    const key = row.file_a;
    if (!clusterMap.has(key)) clusterMap.set(key, new Set([key]));
    clusterMap.get(key)!.add(row.file_b);
  }

  const clusters = Array.from(clusterMap.entries())
    .map(([key, files]) => ({
      theme: key.split("/").pop()?.replace(/\.md$/, "") || key,
      files: Array.from(files),
    }))
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, clusterCount);

  return clusters;
}

export async function getIndexStats(): Promise<{
  totalChunks: number;
  totalFiles: number;
  lastUpdated: string | null;
}> {
  if (!pool) throw new Error("[vault-embeddings] Not initialized");

  const stats = await pool.query(`
    SELECT COUNT(*) AS total_chunks,
           COUNT(DISTINCT file_path) AS total_files,
           MAX(updated_at) AS last_updated
    FROM vault_embeddings
  `);

  const row = stats.rows[0];
  return {
    totalChunks: parseInt(row.total_chunks),
    totalFiles: parseInt(row.total_files),
    lastUpdated: row.last_updated?.toISOString() || null,
  };
}

let reindexTimer: ReturnType<typeof setInterval> | null = null;

export function startScheduledReindex(intervalHours = 6) {
  if (reindexTimer) clearInterval(reindexTimer);
  const intervalMs = intervalHours * 60 * 60 * 1000;
  reindexTimer = setInterval(async () => {
    if (!isConfigured()) return;
    console.log("[vault-embeddings] Scheduled re-index starting...");
    try {
      await indexVault(false);
    } catch (err) {
      console.error("[vault-embeddings] Scheduled re-index failed:", err);
    }
  }, intervalMs);
  console.log(`[vault-embeddings] Scheduled re-index every ${intervalHours}h`);
}

export function stopScheduledReindex() {
  if (reindexTimer) {
    clearInterval(reindexTimer);
    reindexTimer = null;
  }
}
