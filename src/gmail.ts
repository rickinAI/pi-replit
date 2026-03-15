import { google } from "googleapis";
import { getPool } from "./db.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export async function init(): Promise<void> {
  const existing = await getPool().query(`SELECT tokens FROM oauth_tokens WHERE service = 'google'`);
  if (existing.rows.length === 0) {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const legacyPath = path.default.join(process.cwd(), "data", "gmail-tokens.json");
      if (fs.default.existsSync(legacyPath)) {
        const tokens = JSON.parse(fs.default.readFileSync(legacyPath, "utf-8"));
        await getPool().query(
          `INSERT INTO oauth_tokens (service, tokens, updated_at) VALUES ('google', $1, $2)`,
          [JSON.stringify(tokens), Date.now()]
        );
        cachedTokens = tokens;
        tokensCacheTime = Date.now();
        console.log("[gmail] Migrated tokens from data/gmail-tokens.json to PostgreSQL");
      }
    } catch (err) {
      console.error("[gmail] Token migration failed:", err);
    }
  } else {
    cachedTokens = existing.rows[0].tokens;
    tokensCacheTime = Date.now();
  }

  console.log("[gmail] initialized");
}

export function isConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function isConnected(): boolean {
  if (!isConfigured()) return false;
  return !!(cachedTokens && cachedTokens.refresh_token);
}

let cachedTokens: any | null = null;
let tokensCacheTime = 0;

async function loadTokens(): Promise<any | null> {
  try {
    const result = await getPool().query(`SELECT tokens FROM oauth_tokens WHERE service = 'google'`);
    if (result.rows.length > 0) {
      cachedTokens = result.rows[0].tokens;
      tokensCacheTime = Date.now();
      return cachedTokens;
    }
  } catch (err) {
    console.error("[gmail] Failed to load tokens:", err);
  }
  return null;
}

async function saveTokens(tokens: any): Promise<void> {
  cachedTokens = tokens;
  tokensCacheTime = Date.now();
  try {
    await getPool().query(
      `INSERT INTO oauth_tokens (service, tokens, updated_at)
       VALUES ('google', $1, $2)
       ON CONFLICT (service) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(tokens), Date.now()]
    );
  } catch (err) {
    console.error("[gmail] Failed to save tokens:", err);
  }
}

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = getRedirectUri();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getRedirectUri(): string {
  if (process.env.GMAIL_REDIRECT_URI) {
    return process.env.GMAIL_REDIRECT_URI;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}/api/gmail/callback`;
  }
  if (process.env.REPLIT_DOMAINS) {
    const domain = process.env.REPLIT_DOMAINS.split(",")[0];
    return `https://${domain}/api/gmail/callback`;
  }
  const port = process.env.PORT || "3000";
  return `http://localhost:${port}/api/gmail/callback`;
}

export function getAuthUrl(): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

export async function handleCallback(code: string): Promise<void> {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  await saveTokens(tokens);
}

async function getGmailClient() {
  const tokens = await loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Gmail not connected");
  }

  const client = getOAuth2Client();
  client.setCredentials(tokens);

  client.on("tokens", async (newTokens: any) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged);
  });

  const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 60000;
  if (isExpired) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      const merged = { ...tokens, ...credentials };
      await saveTokens(merged);
    } catch (err: any) {
      if (err.message?.includes("invalid_grant")) {
        throw new Error("Gmail authorization expired — need to reconnect");
      }
      throw err;
    }
  }

  return google.gmail({ version: "v1", auth: client });
}

function decodeHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decodeBody(payload: any): string {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
        return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    for (const part of payload.parts) {
      const nested = decodeBody(part);
      if (nested) return nested;
    }
  }

  return "";
}

export async function listEmails(query?: string, maxResults: number = 10): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const params: any = {
      userId: "me",
      maxResults: Math.min(maxResults, 20),
    };
    if (query) params.q = query;

    const listRes = await gmail.users.messages.list(params);
    const messageRefs = listRes.data.messages || [];

    if (messageRefs.length === 0) {
      return query ? `No emails found matching "${query}".` : "Inbox is empty.";
    }

    const details = await Promise.all(
      messageRefs.map(async (ref: any) => {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: ref.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });
        const headers = msg.data.payload?.headers || [];
        return {
          id: ref.id,
          threadId: (msg.data as any).threadId || "",
          from: decodeHeader(headers, "From"),
          subject: decodeHeader(headers, "Subject") || "(no subject)",
          date: decodeHeader(headers, "Date"),
          snippet: msg.data.snippet || "",
          unread: (msg.data.labelIds || []).includes("UNREAD"),
        };
      })
    );

    const lines = details.map((e, i) => {
      const marker = e.unread ? "*" : " ";
      return `${marker} ${i + 1}. [${e.id}] (thread: ${e.threadId})\n   From: ${e.from}\n   Subject: ${e.subject}\n   Date: ${e.date}\n   Preview: ${e.snippet}`;
    });

    const header = query ? `Emails matching "${query}" (${details.length}):` : `Recent emails (${details.length}):`;
    return `${header}\n(* = unread)\n\n${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail listEmails error:", msg);
    if (msg.includes("not connected")) {
      return "Gmail is not connected. Please connect your Gmail account first.";
    }
    if (msg.includes("invalid_grant") || msg.includes("Token has been expired") || msg.includes("authorization expired")) {
      return "Gmail authorization has expired. Rickin needs to visit /api/gmail/auth in the browser to reconnect.";
    }
    return `Unable to check emails right now: ${msg}`;
  }
}

export async function readEmail(messageId: string): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const headers = msg.data.payload?.headers || [];
    const from = decodeHeader(headers, "From");
    const to = decodeHeader(headers, "To");
    const subject = decodeHeader(headers, "Subject") || "(no subject)";
    const date = decodeHeader(headers, "Date");
    const threadId = (msg.data as any).threadId || "";
    const body = decodeBody(msg.data.payload) || "(no readable content)";
    const attachments = findAttachments(msg.data.payload);

    const truncatedBody = body.length > 3000 ? body.slice(0, 3000) + "\n\n[...truncated]" : body;

    let result = `From: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\nThread ID: ${threadId}\n`;
    if (attachments.length > 0) {
      result += `Attachments: ${attachments.map(a => `${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)}KB) [id: ${a.attachmentId}]`).join("; ")}\n`;
    }
    result += `\n${truncatedBody}`;
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail readEmail error:", msg);
    if (msg.includes("not connected")) {
      return "Gmail is not connected. Please connect your Gmail account first.";
    }
    if (msg.includes("404") || msg.includes("Not Found")) {
      return "That email could not be found. It may have been deleted.";
    }
    if (msg.includes("invalid_grant") || msg.includes("authorization expired")) {
      return "Gmail authorization has expired. Rickin needs to visit /api/gmail/auth in the browser to reconnect.";
    }
    return `Unable to read this email right now: ${msg}`;
  }
}

export async function searchEmails(query: string): Promise<string> {
  return listEmails(query, 10);
}

export async function searchEmailsStructured(query: string, maxResults = 5): Promise<Array<{ subject: string; from: string; date: string; unread: boolean }>> {
  try {
    const client = await getGmailClient();
    const listRes = await client.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(maxResults, 10),
    });
    const messageRefs = (listRes.data as any).messages || [];
    if (messageRefs.length === 0) return [];
    const details = await Promise.all(
      messageRefs.map(async (ref: any) => {
        const msg = await client.users.messages.get({
          userId: "me",
          id: ref.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });
        const headers = (msg.data as any).payload?.headers || [];
        const getH = (name: string) => headers.find((h: any) => h.name === name)?.value || "";
        return {
          subject: getH("Subject") || "(no subject)",
          from: getH("From").replace(/<.*>/, "").trim(),
          date: getH("Date"),
          unread: ((msg.data as any).labelIds || []).includes("UNREAD"),
        };
      })
    );
    return details;
  } catch {
    return [];
  }
}

export async function getUnreadCount(): Promise<number> {
  try {
    const client = await getGmailClient();
    const res = await client.users.messages.list({
      userId: "me",
      q: "is:unread category:primary",
      maxResults: 1,
    });
    return (res.data as any).resultSizeEstimate || 0;
  } catch (err) {
    console.error("Gmail getUnreadCount error:", err instanceof Error ? err.message : err);
    return 0;
  }
}

export async function getConnectedEmail(): Promise<string | null> {
  try {
    const client = await getGmailClient();
    const profile = await client.users.getProfile({ userId: "me" });
    return profile.data.emailAddress || null;
  } catch {
    return null;
  }
}

export async function getAccessToken(): Promise<string | null> {
  try {
    const tokens = await loadTokens();
    if (!tokens || !tokens.refresh_token) return null;

    const client = getOAuth2Client();
    client.setCredentials(tokens);

    const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 60000;
    if (isExpired) {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      const merged = { ...tokens, ...credentials };
      await saveTokens(merged);
      return credentials.access_token || null;
    }

    return tokens.access_token || null;
  } catch (err) {
    console.error("[gmail] Failed to get access token:", err instanceof Error ? err.message : err);
    return null;
  }
}

export interface DarkNodeEmail {
  messageId: string;
  subject: string;
  from: string;
  date: string;
  body: string;
  instruction: string;
}

const TRUSTED_SENDERS = [
  "rickin.patel@gmail.com",
  "rickin@rickin.live",
];

function isTrustedSender(from: string): boolean {
  const emailMatch = from.match(/<([^>]+)>/);
  const email = emailMatch ? emailMatch[1].toLowerCase() : from.toLowerCase().trim();
  return TRUSTED_SENDERS.some(trusted => email === trusted || email.endsWith(`<${trusted}>`));
}

export async function getDarkNodeEmails(): Promise<DarkNodeEmail[]> {
  try {
    const gmail = await getGmailClient();
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread from:me @darknode",
      maxResults: 5,
    });
    const messageRefs = listRes.data.messages || [];
    if (messageRefs.length === 0) return [];

    const processedIds = await getProcessedDarkNodeIds();

    const results: DarkNodeEmail[] = [];
    for (const ref of messageRefs) {
      if (processedIds.has(ref.id!)) continue;

      const msg = await gmail.users.messages.get({
        userId: "me",
        id: ref.id!,
        format: "full",
      });
      const headers = msg.data.payload?.headers || [];
      const from = decodeHeader(headers, "From");

      if (!isTrustedSender(from)) {
        console.log(`[gmail] getDarkNodeEmails: skipping untrusted sender: ${from}`);
        await markDarkNodeProcessed(ref.id!);
        continue;
      }

      const subject = decodeHeader(headers, "Subject") || "(no subject)";
      const date = decodeHeader(headers, "Date");
      const body = decodeBody(msg.data.payload) || "(no readable content)";

      const instruction = extractDarkNodeInstruction(body);
      if (!instruction) continue;

      results.push({
        messageId: ref.id!,
        subject,
        from,
        date,
        body: body.length > 5000 ? body.slice(0, 5000) + "\n\n[...truncated]" : body,
        instruction,
      });
    }

    return results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gmail] getDarkNodeEmails error:", msg);
    return [];
  }
}

function extractDarkNodeInstruction(body: string): string | null {
  const lines = body.split(/\n/);
  for (const line of lines) {
    if (line.trimStart().startsWith(">")) continue;
    const match = line.match(/@darknode\s*[-–—:]?\s*(.+)/i);
    if (match) {
      let instruction = match[1].trim();
      if (instruction.length === 0) continue;
      if (instruction.length > 200) instruction = instruction.slice(0, 200);
      return instruction;
    }
  }
  return null;
}

async function getProcessedDarkNodeIds(): Promise<Set<string>> {
  try {
    const result = await getPool().query(`SELECT value FROM app_config WHERE key = 'darknode_processed_emails'`);
    if (result.rows.length > 0) {
      const ids: string[] = result.rows[0].value.ids || [];
      return new Set(ids);
    }
  } catch {}
  return new Set();
}

export async function markDarkNodeProcessed(messageId: string): Promise<void> {
  try {
    const existing = await getProcessedDarkNodeIds();
    existing.add(messageId);
    const ids = [...existing].slice(-200);
    await getPool().query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('darknode_processed_emails', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify({ ids }), Date.now()]
    );
  } catch (err) {
    console.error("[gmail] markDarkNodeProcessed error:", err);
  }
}

function findAttachments(payload: any): Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> {
  const attachments: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> = [];
  function walk(part: any) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      for (const p of part.parts) walk(p);
    }
  }
  walk(payload);
  return attachments;
}

export async function getAttachment(messageId: string, attachmentId?: string, filename?: string): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const allAttachments = findAttachments(msg.data.payload);

    if (allAttachments.length === 0) {
      return "This email has no attachments.";
    }

    let target = allAttachments[0];
    if (attachmentId) {
      const found = allAttachments.find(a => a.attachmentId === attachmentId);
      if (found) { target = found; } else {
        const listStr = allAttachments.map(a => `- ${a.filename} (${a.mimeType}) [id: ${a.attachmentId}]`).join("\n");
        return `Attachment ID not found. Available attachments:\n${listStr}`;
      }
    } else if (filename) {
      const found = allAttachments.find(a => a.filename.toLowerCase().includes(filename.toLowerCase()));
      if (found) { target = found; } else {
        const listStr = allAttachments.map(a => `- ${a.filename} (${a.mimeType})`).join("\n");
        return `No attachment matching "${filename}". Available attachments:\n${listStr}`;
      }
    }

    const attRes = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: target.attachmentId,
    });

    const rawData = attRes.data.data;
    if (!rawData) return "Attachment data could not be retrieved.";

    const buffer = Buffer.from(rawData, "base64url");

    if (target.mimeType === "application/pdf" || target.filename.toLowerCase().endsWith(".pdf")) {
      try {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        await parser.load();
        const textResult = await parser.getText();
        const text = (typeof textResult === "string" ? textResult : textResult?.text ?? "").trim();
        const info = await parser.getInfo();
        const numPages = info?.total ?? "?";
        await parser.destroy();
        if (text.length > 0) {
          const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n\n[...truncated]" : text;
          return `📎 ${target.filename} (PDF, ${numPages} pages)\n\n${truncated}`;
        }
        return `📎 ${target.filename} — PDF has no extractable text (may be scanned/image-based).`;
      } catch (pdfErr) {
        return `📎 ${target.filename} — PDF parsing failed: ${pdfErr instanceof Error ? pdfErr.message : String(pdfErr)}`;
      }
    }

    if (target.mimeType.startsWith("text/") || target.mimeType === "application/json" || target.mimeType === "application/xml") {
      const textContent = buffer.toString("utf-8");
      const truncated = textContent.length > 8000 ? textContent.slice(0, 8000) + "\n\n[...truncated]" : textContent;
      return `📎 ${target.filename}\n\n${truncated}`;
    }

    if (target.mimeType.startsWith("image/")) {
      const b64 = buffer.toString("base64");
      return `📎 ${target.filename} (${target.mimeType}, ${Math.round(buffer.length / 1024)}KB)\n[Image attachment — base64 data available but not displayed as text]`;
    }

    const listStr = allAttachments.map((a, i) => `${i + 1}. ${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)}KB) [attachmentId: ${a.attachmentId}]`).join("\n");
    return `📎 ${target.filename} is a binary file (${target.mimeType}, ${Math.round(buffer.length / 1024)}KB). Cannot display as text.\n\nAll attachments:\n${listStr}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail getAttachment error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("404")) return "Email or attachment not found.";
    return `Unable to read attachment: ${msg}`;
  }
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function buildRfc2822Message(to: string, subject: string, body: string, options?: {
  cc?: string; bcc?: string; inReplyTo?: string; references?: string; threadId?: string;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${sanitizeHeader(to)}`);
  if (options?.cc) lines.push(`Cc: ${sanitizeHeader(options.cc)}`);
  if (options?.bcc) lines.push(`Bcc: ${sanitizeHeader(options.bcc)}`);
  lines.push(`Subject: ${sanitizeHeader(subject)}`);
  lines.push(`Content-Type: text/plain; charset="UTF-8"`);
  if (options?.inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeader(options.inReplyTo)}`);
  if (options?.references) lines.push(`References: ${sanitizeHeader(options.references)}`);
  lines.push("");
  lines.push(body);
  return lines.join("\r\n");
}

export async function sendEmail(to: string, subject: string, body: string, cc?: string, bcc?: string): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const raw = buildRfc2822Message(to, subject, body, { cc, bcc });
    const encoded = Buffer.from(raw).toString("base64url");

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded },
    });

    return `✅ Email sent successfully.\nTo: ${to}\nSubject: ${subject}\nMessage ID: ${res.data.id}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail sendEmail error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("invalid_grant") || msg.includes("authorization expired")) {
      return "Gmail authorization expired — need to reconnect. Visit /api/gmail/auth.";
    }
    return `Failed to send email: ${msg}`;
  }
}

export async function replyToEmail(messageId: string, body: string, replyAll: boolean = false): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const original = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const headers = original.data.payload?.headers || [];
    const origFrom = decodeHeader(headers, "From");
    const origTo = decodeHeader(headers, "To");
    const origCc = decodeHeader(headers, "Cc");
    const origSubject = decodeHeader(headers, "Subject");
    const origMessageId = decodeHeader(headers, "Message-ID") || decodeHeader(headers, "Message-Id");
    const origReferences = decodeHeader(headers, "References");
    const threadId = original.data.threadId || undefined;

    const replyTo = origFrom;
    let cc: string | undefined;
    if (replyAll) {
      const allRecipients = [origTo, origCc].filter(Boolean).join(", ");
      cc = allRecipients || undefined;
    }

    const subject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;
    const references = origReferences ? `${origReferences} ${origMessageId}` : origMessageId;

    const raw = buildRfc2822Message(replyTo, subject, body, {
      cc,
      inReplyTo: origMessageId,
      references,
      threadId,
    });
    const encoded = Buffer.from(raw).toString("base64url");

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded, threadId },
    });

    return `✅ Reply sent successfully.\nTo: ${replyTo}${cc ? `\nCc: ${cc}` : ""}\nSubject: ${subject}\nMessage ID: ${res.data.id}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail replyToEmail error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    return `Failed to send reply: ${msg}`;
  }
}

export async function getThread(threadId: string): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const messages = thread.data.messages || [];

    if (messages.length === 0) return "Thread has no messages.";

    const formatted = messages.map((msg, i) => {
      const headers = msg.payload?.headers || [];
      const from = decodeHeader(headers, "From");
      const to = decodeHeader(headers, "To");
      const date = decodeHeader(headers, "Date");
      const subject = decodeHeader(headers, "Subject");
      const body = decodeBody(msg.payload) || "(no readable content)";
      const truncatedBody = body.length > 2000 ? body.slice(0, 2000) + "\n[...truncated]" : body;
      return `--- Message ${i + 1} of ${messages.length} [${msg.id}] ---\nFrom: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${truncatedBody}`;
    });

    return `Thread: ${messages.length} messages\n\n${formatted.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail getThread error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("404")) return "Thread not found.";
    return `Unable to read thread: ${msg}`;
  }
}

export async function createDraft(to: string, subject: string, body: string, cc?: string, bcc?: string): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const raw = buildRfc2822Message(to, subject, body, { cc, bcc });
    const encoded = Buffer.from(raw).toString("base64url");

    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: encoded } },
    });

    return `✅ Draft saved.\nTo: ${to}\nSubject: ${subject}\nDraft ID: ${res.data.id}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail createDraft error:", msg);
    return `Failed to save draft: ${msg}`;
  }
}

export async function archiveEmail(messageId: string): Promise<string> {
  try {
    const gmail = await getGmailClient();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["INBOX"] },
    });
    return `✅ Email archived (removed from inbox).`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail archiveEmail error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to archive: ${msg}`;
  }
}

export async function modifyLabels(messageId: string, addLabels?: string[], removeLabels?: string[]): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const body: any = {};
    if (addLabels && addLabels.length > 0) body.addLabelIds = addLabels;
    if (removeLabels && removeLabels.length > 0) body.removeLabelIds = removeLabels;

    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: body });

    const parts: string[] = [];
    if (addLabels?.length) parts.push(`Added: ${addLabels.join(", ")}`);
    if (removeLabels?.length) parts.push(`Removed: ${removeLabels.join(", ")}`);
    return `✅ Labels updated. ${parts.join(". ")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail modifyLabels error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to modify labels: ${msg}`;
  }
}

export async function markRead(messageId: string, read: boolean): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const body = read
      ? { removeLabelIds: ["UNREAD"] }
      : { addLabelIds: ["UNREAD"] };

    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: body });
    return `✅ Email marked as ${read ? "read" : "unread"}.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail markRead error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to update read status: ${msg}`;
  }
}

export async function trashEmail(messageId: string): Promise<string> {
  try {
    const gmail = await getGmailClient();
    await gmail.users.messages.trash({ userId: "me", id: messageId });
    return `✅ Email moved to trash.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail trashEmail error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to trash email: ${msg}`;
  }
}

export async function listLabels(): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels || [];

    if (labels.length === 0) return "No labels found.";

    const system: Array<{ id: string; name: string }> = [];
    const user: Array<{ id: string; name: string }> = [];

    for (const l of labels) {
      const entry = { id: l.id!, name: l.name! };
      if (l.type === "system") system.push(entry);
      else user.push(entry);
    }

    system.sort((a, b) => a.name.localeCompare(b.name));
    user.sort((a, b) => a.name.localeCompare(b.name));

    const lines: string[] = [];
    if (user.length > 0) {
      lines.push(`Custom labels (${user.length}):`);
      for (const l of user) lines.push(`  • ${l.name}  [id: ${l.id}]`);
    }
    lines.push(`\nSystem labels (${system.length}):`);
    for (const l of system) lines.push(`  • ${l.name}  [id: ${l.id}]`);

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail listLabels error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    return `Failed to list labels: ${msg}`;
  }
}

export async function createLabel(name: string, options?: {
  labelListVisibility?: string;
  messageListVisibility?: string;
  backgroundColor?: string;
  textColor?: string;
}): Promise<string> {
  try {
    const gmail = await getGmailClient();
    const body: any = {
      name,
      labelListVisibility: options?.labelListVisibility || "labelShow",
      messageListVisibility: options?.messageListVisibility || "show",
    };
    if (options?.backgroundColor || options?.textColor) {
      body.color = {};
      if (options.backgroundColor) body.color.backgroundColor = options.backgroundColor;
      if (options.textColor) body.color.textColor = options.textColor;
    }

    const res = await gmail.users.labels.create({ userId: "me", requestBody: body });
    return `✅ Label created.\nName: ${res.data.name}\nID: ${res.data.id}\n\nUse this ID with the email_label tool to apply it to emails.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail createLabel error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("already exists") || msg.includes("409")) return `Label "${name}" already exists. Use gmail_list_labels to find its ID.`;
    return `Failed to create label: ${msg}`;
  }
}

export async function deleteLabel(labelId: string): Promise<string> {
  try {
    const gmail = await getGmailClient();
    await gmail.users.labels.delete({ userId: "me", id: labelId });
    return `✅ Label deleted (ID: ${labelId}).`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail deleteLabel error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("404")) return "Label not found. It may have already been deleted.";
    if (msg.includes("invalid")) return "Cannot delete system labels — only custom labels can be deleted.";
    return `Failed to delete label: ${msg}`;
  }
}

export async function checkConnectionStatus(): Promise<{ connected: boolean; email?: string; error?: string }> {
  if (!isConfigured()) return { connected: false, error: "GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set" };
  if (!isConnected()) return { connected: false, error: "No OAuth tokens — visit /api/gmail/auth to connect" };
  try {
    const email = await getConnectedEmail();
    if (email) return { connected: true, email };
    return { connected: false, error: "Token invalid — visit /api/gmail/auth to reconnect" };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) };
  }
}
