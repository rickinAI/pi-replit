import fs from "fs";
import path from "path";

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

let dataDir = "";

export function init(dir: string) {
  dataDir = dir;
  fs.mkdirSync(dataDir, { recursive: true });
}

function filePath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(dataDir, `${safe}.json`);
}

export function save(conv: Conversation): void {
  conv.updatedAt = Date.now();
  fs.writeFileSync(filePath(conv.id), JSON.stringify(conv, null, 2));
}

export function load(id: string): Conversation | null {
  const fp = filePath(id);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8")) as Conversation;
  } catch {
    return null;
  }
}

export function list(): ConversationSummary[] {
  if (!fs.existsSync(dataDir)) return [];
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith(".json"));
  const summaries: ConversationSummary[] = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf-8")) as Conversation;
      summaries.push({
        id: raw.id,
        title: raw.title,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        messageCount: raw.messages.length,
      });
    } catch {}
  }

  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

export function remove(id: string): boolean {
  const fp = filePath(id);
  if (!fs.existsSync(fp)) return false;
  fs.unlinkSync(fp);
  return true;
}

export function getRecentSummary(count: number = 3): string {
  const recent = list().slice(0, count);
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

export interface SearchResult {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  snippets: string[];
}

export function search(query: string, options?: { before?: number; after?: number; limit?: number }): SearchResult[] {
  if (!fs.existsSync(dataDir)) return [];
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith(".json"));
  const results: SearchResult[] = [];
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const limit = options?.limit ?? 10;

  for (const file of files) {
    try {
      const conv = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf-8")) as Conversation;

      if (options?.before && conv.createdAt > options.before) continue;
      if (options?.after && conv.createdAt < options.after) continue;

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
    } catch {}
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results.slice(0, limit);
}

export function shouldSync(conv: Conversation): boolean {
  const userMessages = conv.messages.filter(m => m.role === "user");
  return userMessages.length >= 4;
}

export function generateSummaryMarkdown(conv: Conversation): string {
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
