import Anthropic from "@anthropic-ai/sdk";
import { getPool } from "./db.js";

export interface ImageAttachment {
  mimeType: string;
  data: string;
}

export interface ConversationMessage {
  role: "user" | "agent" | "system";
  text: string;
  timestamp: number;
  images?: ImageAttachment[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export async function init(): Promise<void> {
  console.log("[conversations] initialized");
}

export async function save(conv: Conversation): Promise<void> {
  conv.updatedAt = Date.now();
  await getPool().query(
    `INSERT INTO conversations (id, title, messages, created_at, updated_at, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       messages = EXCLUDED.messages,
       updated_at = EXCLUDED.updated_at,
       synced_at = EXCLUDED.synced_at`,
    [conv.id, conv.title, JSON.stringify(conv.messages), conv.createdAt, conv.updatedAt, (conv as any).syncedAt || null]
  );
}

export async function load(id: string): Promise<Conversation | null> {
  const result = await getPool().query(
    `SELECT id, title, messages, created_at, updated_at, synced_at FROM conversations WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return rowToConversation(result.rows[0]);
}

export async function list(): Promise<ConversationSummary[]> {
  const result = await getPool().query(
    `SELECT DISTINCT ON (title) id, title, messages, created_at, updated_at
     FROM conversations ORDER BY title, updated_at DESC`
  );
  const rows = result.rows.map(row => ({
    id: row.id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: Array.isArray(row.messages) ? row.messages.length : 0,
  }));
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

export async function remove(id: string): Promise<boolean> {
  const result = await getPool().query(`DELETE FROM conversations WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function getRecentSummary(count: number = 3): Promise<string> {
  const recent = (await list()).slice(0, count);
  if (recent.length === 0) return "";

  const lines = recent.map(c => {
    const date = new Date(c.createdAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `- "${c.title}" (${date}, ${c.messageCount} messages)`;
  });

  return `Recent conversations:\n${lines.join("\n")}`;
}

export async function getLastConversationContext(maxMessages: number = 10): Promise<string> {
  const result = await getPool().query(
    `SELECT id, title, messages, created_at, updated_at FROM conversations
     WHERE jsonb_array_length(messages) > 0
     ORDER BY updated_at DESC LIMIT 1`
  );
  if (result.rows.length === 0) return "";

  const mostRecent = rowToConversation(result.rows[0]);

  const relevantMsgs = mostRecent.messages
    .filter(m => m.role !== "system")
    .slice(-maxMessages);

  if (relevantMsgs.length === 0) return "";

  const date = new Date(mostRecent.createdAt).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = new Date(mostRecent.updatedAt).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });

  const exchanges = relevantMsgs.map(m => {
    const role = m.role === "user" ? "Rickin" : "You";
    const text = m.text.length > 300 ? m.text.slice(0, 300) + "..." : m.text;
    return `**${role}:** ${text}`;
  }).join("\n\n");

  return `Your last conversation with Rickin was "${mostRecent.title}" (${date}, last active ${time}):\n\n${exchanges}`;
}

export function createConversation(sessionId: string): Conversation {
  return {
    id: sessionId,
    title: "New conversation",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function addMessage(conv: Conversation, role: "user" | "agent" | "system", text: string, images?: ImageAttachment[]): void {
  const msg: ConversationMessage = { role, text, timestamp: Date.now() };
  if (images && images.length > 0) {
    msg.images = images;
  }
  conv.messages.push(msg);
  if (conv.title === "New conversation" && role === "user" && text.trim()) {
    conv.title = text.trim().slice(0, 60);
  }
  conv.updatedAt = Date.now();
}

export async function generateTitle(conv: Conversation): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const nonSystem = conv.messages.filter(m => m.role !== "system");
  if (nonSystem.length < 2) return null;

  const transcript = nonSystem.slice(0, 6).map(m => {
    const role = m.role === "user" ? "User" : "Assistant";
    const text = m.text.length > 300 ? m.text.slice(0, 300) + "..." : m.text;
    return `${role}: ${text}`;
  }).join("\n");

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 40,
      messages: [{
        role: "user",
        content: `Write a short title (max 6 words) for this conversation. Just the title, no quotes or punctuation at the end.\n\n${transcript}`,
      }],
    });
    const title = response.content[0]?.type === "text" ? response.content[0].text.trim() : null;
    if (title && title.length > 0 && title.length <= 80) {
      conv.title = title;
      return title;
    }
  } catch (err) {
    console.warn("[conversations] Title generation failed:", err);
  }
  return null;
}

export interface SearchResult {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  snippets: string[];
}

export async function search(query: string, options?: { before?: number; after?: number; limit?: number }): Promise<SearchResult[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return [];
  const limit = options?.limit ?? 10;

  let sql = `SELECT id, title, messages, created_at, updated_at FROM conversations WHERE 1=1`;
  const params: any[] = [];
  let paramIdx = 1;

  if (options?.before) {
    sql += ` AND created_at <= $${paramIdx++}`;
    params.push(options.before);
  }
  if (options?.after) {
    sql += ` AND created_at >= $${paramIdx++}`;
    params.push(options.after);
  }

  sql += ` ORDER BY updated_at DESC`;

  const result = await getPool().query(sql, params);
  const results: SearchResult[] = [];

  for (const row of result.rows) {
    const conv = rowToConversation(row);
    const snippets: string[] = [];

    for (const msg of conv.messages) {
      if (msg.role === "system") continue;
      const lower = msg.text.toLowerCase();
      if (terms.some(t => lower.includes(t))) {
        const snippet = msg.text.slice(0, 200);
        const role = msg.role === "user" ? "You" : "Agent";
        const time = new Date(msg.timestamp).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        snippets.push(`[${role}, ${time}] ${snippet}`);
        if (snippets.length >= 3) break;
      }
    }

    if (snippets.length > 0) {
      results.push({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages.length,
        snippets,
      });
    }

    if (results.length >= limit) break;
  }

  return results;
}

export function shouldSync(conv: Conversation): boolean {
  const userMessages = conv.messages.filter(m => m.role === "user");
  return userMessages.length >= 1;
}

export function generateSnippetSummary(conv: Conversation): string {
  const date = new Date(conv.createdAt).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = new Date(conv.createdAt).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });

  const userMsgs = conv.messages.filter(m => m.role === "user").map(m => m.text.trim());
  const agentMsgs = conv.messages.filter(m => m.role === "agent").map(m => m.text.trim());

  const topicLines = userMsgs.slice(0, 8).map(t => `- ${t.slice(0, 120)}`).join("\n");

  let keyPoints = "";
  for (const a of agentMsgs) {
    const lines = a.split("\n").filter(l => l.trim().length > 10);
    for (const line of lines.slice(0, 2)) {
      keyPoints += `- ${line.trim().slice(0, 150)}\n`;
    }
    if (keyPoints.split("\n").length > 6) break;
  }

  return `# ${conv.title}

**Date:** ${date} at ${time}
**Messages:** ${conv.messages.length}

## Topics Discussed
${topicLines}

## Key Points
${keyPoints.trim() || "- General discussion"}

---
*Session ID: ${conv.id}*
`;
}

export async function generateAISummary(conv: Conversation): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[conversations] No ANTHROPIC_API_KEY — falling back to snippet summary");
    return generateSnippetSummary(conv);
  }

  const date = new Date(conv.createdAt).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = new Date(conv.createdAt).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });

  const transcript = conv.messages
    .filter(m => m.role !== "system")
    .map(m => {
      const role = m.role === "user" ? "Rickin" : "Assistant";
      const text = m.text.length > 500 ? m.text.slice(0, 500) + "..." : m.text;
      return `${role}: ${text}`;
    })
    .join("\n\n");

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `Summarize this conversation between Rickin and his AI assistant. Write in third person about what was discussed.

Format your response EXACTLY as markdown with these sections:
## Summary
2-3 sentences capturing the main topics and purpose of the conversation.

## Key Decisions & Outcomes
- Bullet points of any decisions made, answers given, or outcomes reached
- If none, write "- General discussion, no specific decisions"

## Action Items
- Any tasks, follow-ups, or things to do that came up
- If none, write "- No action items"

## Topics for Follow-up
- Things that were mentioned but not fully resolved, or areas to revisit
- If none, write "- None identified"

CONVERSATION:
${transcript}`
      }],
    });

    const aiText = response.content[0]?.type === "text" ? response.content[0].text : "";

    return `# ${conv.title}

**Date:** ${date} at ${time}
**Messages:** ${conv.messages.length}

${aiText}

---
*Session ID: ${conv.id}*
`;
  } catch (err) {
    console.error("[conversations] AI summary failed, falling back to snippet:", err);
    return generateSnippetSummary(conv);
  }
}

function rowToConversation(row: any): Conversation {
  const conv: Conversation = {
    id: row.id,
    title: row.title,
    messages: Array.isArray(row.messages) ? row.messages : JSON.parse(row.messages || "[]"),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.synced_at) {
    (conv as any).syncedAt = Number(row.synced_at);
  }
  return conv;
}
