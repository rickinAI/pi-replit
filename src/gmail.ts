import { google } from "googleapis";
import fs from "fs";
import path from "path";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
];

let tokenFilePath = "";
let projectRoot = "";

export function init(root: string) {
  projectRoot = root;
  tokenFilePath = path.join(root, "data", "gmail-tokens.json");
  fs.mkdirSync(path.dirname(tokenFilePath), { recursive: true });
}

export function isConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function isConnected(): boolean {
  if (!isConfigured()) return false;
  try {
    const tokens = loadTokens();
    return !!(tokens && tokens.refresh_token);
  } catch {
    return false;
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
  saveTokens(tokens);
}

function saveTokens(tokens: any): void {
  fs.writeFileSync(tokenFilePath, JSON.stringify(tokens, null, 2));
}

function loadTokens(): any | null {
  if (!fs.existsSync(tokenFilePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenFilePath, "utf-8"));
  } catch {
    return null;
  }
}

async function getGmailClient() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Gmail not connected");
  }

  const client = getOAuth2Client();
  client.setCredentials(tokens);

  client.on("tokens", (newTokens: any) => {
    const merged = { ...tokens, ...newTokens };
    saveTokens(merged);
  });

  const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 60000;
  if (isExpired) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      const merged = { ...tokens, ...credentials };
      saveTokens(merged);
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
      return `${marker} ${i + 1}. [${e.id}]\n   From: ${e.from}\n   Subject: ${e.subject}\n   Date: ${e.date}\n   Preview: ${e.snippet}`;
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
    const body = decodeBody(msg.data.payload) || "(no readable content)";

    const truncatedBody = body.length > 3000 ? body.slice(0, 3000) + "\n\n[...truncated]" : body;

    return `From: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\n\n${truncatedBody}`;
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

export async function getUnreadCount(): Promise<number> {
  try {
    const client = await getGmailClient();
    const res = await client.users.messages.list({
      userId: "me",
      q: "is:unread newer_than:1d category:primary",
      maxResults: 1,
    });
    return res.data.resultSizeEstimate || 0;
  } catch {
    try {
      const client = await getGmailClient();
      const res = await client.users.messages.list({
        userId: "me",
        q: "is:unread newer_than:1d",
        maxResults: 1,
      });
      return res.data.resultSizeEstimate || 0;
    } catch (err) {
      console.error("Gmail getUnreadCount error:", err instanceof Error ? err.message : err);
      return 0;
    }
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
