import { google } from "googleapis";
import fs from "fs";
import path from "path";

let tokenFilePath = "";

export function init(root: string) {
  tokenFilePath = path.join(root, "data", "gmail-tokens.json");
}

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || "";
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function loadTokens(): any | null {
  if (!fs.existsSync(tokenFilePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenFilePath, "utf-8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens: any): void {
  fs.writeFileSync(tokenFilePath, JSON.stringify(tokens, null, 2));
}

async function getCalendarClient() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Google not connected — need to authorize first");
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
      saveTokens({ ...tokens, ...credentials });
    } catch (err: any) {
      if (err.message?.includes("invalid_grant")) {
        throw new Error("Google authorization expired — need to reconnect");
      }
      throw err;
    }
  }

  return google.calendar({ version: "v3", auth: client });
}

export function isConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export async function listEvents(options?: { maxResults?: number; timeMin?: string; timeMax?: string }): Promise<string> {
  try {
    const calendar = await getCalendarClient();
    const now = new Date();
    const params: any = {
      calendarId: "primary",
      timeMin: options?.timeMin || now.toISOString(),
      maxResults: options?.maxResults || 10,
      singleEvents: true,
      orderBy: "startTime",
    };
    if (options?.timeMax) params.timeMax = options.timeMax;

    const res = await calendar.events.list(params);
    const events = res.data.items || [];

    if (events.length === 0) return "No upcoming events found.";

    const lines = events.map((event: any, i: number) => {
      const start = event.start?.dateTime
        ? new Date(event.start.dateTime).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : event.start?.date || "TBD";
      const end = event.end?.dateTime
        ? new Date(event.end.dateTime).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })
        : "";
      const location = event.location ? `\n   Location: ${event.location}` : "";
      const desc = event.description ? `\n   ${event.description.slice(0, 100).replace(/\n/g, " ")}` : "";
      return `${i + 1}. ${event.summary || "(No title)"}\n   ${start}${end ? ` - ${end}` : ""}${location}${desc}`;
    });

    return `Upcoming events (${events.length}):\n\n${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Calendar listEvents error:", msg);
    if (msg.includes("authorization expired") || msg.includes("invalid_grant")) {
      return "Google authorization has expired. Rickin needs to reconnect at /api/gmail/auth.";
    }
    if (msg.includes("insufficient")) {
      return "Calendar access not authorized. Rickin needs to reconnect at /api/gmail/auth to grant calendar permissions.";
    }
    return `Unable to fetch calendar events: ${msg}`;
  }
}

export async function createEvent(summary: string, options: { startTime: string; endTime?: string; description?: string; location?: string; allDay?: boolean }): Promise<string> {
  try {
    const calendar = await getCalendarClient();

    let start: any;
    let end: any;

    if (options.allDay) {
      start = { date: options.startTime.split("T")[0] };
      const endDate = options.endTime ? options.endTime.split("T")[0] : options.startTime.split("T")[0];
      const d = new Date(endDate);
      d.setDate(d.getDate() + 1);
      end = { date: d.toISOString().split("T")[0] };
    } else {
      start = { dateTime: options.startTime, timeZone: "America/New_York" };
      if (options.endTime) {
        end = { dateTime: options.endTime, timeZone: "America/New_York" };
      } else {
        const endTime = new Date(new Date(options.startTime).getTime() + 60 * 60 * 1000);
        end = { dateTime: endTime.toISOString(), timeZone: "America/New_York" };
      }
    }

    const event: any = {
      summary,
      start,
      end,
    };
    if (options.description) event.description = options.description;
    if (options.location) event.location = options.location;

    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event,
    });

    const created = res.data;
    const startStr = created.start?.dateTime
      ? new Date(created.start.dateTime).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : created.start?.date || "";

    return `Created event: "${summary}" on ${startStr}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Calendar createEvent error:", msg);
    if (msg.includes("authorization expired") || msg.includes("invalid_grant")) {
      return "Google authorization has expired. Rickin needs to reconnect at /api/gmail/auth.";
    }
    if (msg.includes("insufficient") || msg.includes("Forbidden")) {
      return "Calendar write access not authorized. Rickin needs to reconnect at /api/gmail/auth to grant calendar permissions.";
    }
    return `Unable to create event: ${msg}`;
  }
}
