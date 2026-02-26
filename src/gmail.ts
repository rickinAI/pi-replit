import { google } from "googleapis";

let connectionSettings: any;

async function getAccessToken() {
  if (connectionSettings?.settings?.access_token && connectionSettings.settings.expires_at) {
    const expiresAt = new Date(connectionSettings.settings.expires_at).getTime();
    if (expiresAt > Date.now() + 60_000) {
      return connectionSettings.settings.access_token;
    }
  }
  connectionSettings = null;

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken) {
    throw new Error("X-Replit-Token not found for repl/depl");
  }

  connectionSettings = await fetch(
    "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=google-mail",
    {
      headers: {
        Accept: "application/json",
        "X-Replit-Token": xReplitToken,
      },
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error("Gmail not connected");
  }
  return accessToken;
}

async function getGmailClient() {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

export function isConfigured(): boolean {
  return !!(process.env.REPLIT_CONNECTORS_HOSTNAME && (process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL));
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
    if (msg.includes("not connected") || msg.includes("X-Replit-Token")) {
      return "Gmail is not connected. Please reconnect your Gmail account.";
    }
    return "Unable to check emails right now. Please try again shortly.";
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
    if (msg.includes("not connected") || msg.includes("X-Replit-Token")) {
      return "Gmail is not connected. Please reconnect your Gmail account.";
    }
    if (msg.includes("404") || msg.includes("Not Found")) {
      return "That email could not be found. It may have been deleted.";
    }
    return "Unable to read this email right now. Please try again shortly.";
  }
}

export async function searchEmails(query: string): Promise<string> {
  return listEmails(query, 10);
}
