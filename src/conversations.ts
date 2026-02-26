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
