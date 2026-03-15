import { google } from "googleapis";
import { getPool } from "./db.js";

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || "";
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function loadTokens(): Promise<any | null> {
  try {
    const result = await getPool().query(`SELECT tokens FROM oauth_tokens WHERE service = 'google'`);
    if (result.rows.length > 0) {
      return result.rows[0].tokens;
    }
  } catch (err) {
    console.error("[calendar] Failed to load tokens:", err);
  }
  return null;
}

async function saveTokens(tokens: any): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO oauth_tokens (service, tokens, updated_at)
       VALUES ('google', $1, $2)
       ON CONFLICT (service) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(tokens), Date.now()]
    );
  } catch (err) {
    console.error("[calendar] Failed to save tokens:", err);
  }
}

async function getCalendarClient() {
  const tokens = await loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Google not connected — need to authorize first");
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
      await saveTokens({ ...tokens, ...credentials });
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
    const cal = await getCalendarClient();
    const now = new Date();
    const timeMin = options?.timeMin || now.toISOString();
    const maxResults = options?.maxResults || 10;

    let calendarIds: string[] = ["primary"];
    try {
      const calList = await cal.calendarList.list({ minAccessRole: "reader" });
      const items = calList.data.items || [];
      if (items.length > 0) {
        calendarIds = items
          .filter((c: any) => c.selected !== false)
          .map((c: any) => c.id)
          .filter(Boolean);
        if (calendarIds.length === 0) calendarIds = ["primary"];
      }
      console.log(`[calendar] Querying ${calendarIds.length} calendar(s): ${calendarIds.join(", ")}`);
    } catch (err) {
      console.log("[calendar] Could not list calendars, falling back to primary");
    }

    console.log(`[calendar] Query range: ${timeMin} to ${options?.timeMax || "open-ended"}`);

    const allEvents: any[] = [];
    for (const calId of calendarIds) {
      try {
        const params: any = {
          calendarId: calId,
          timeMin,
          maxResults,
          singleEvents: true,
          orderBy: "startTime",
        };
        if (options?.timeMax) params.timeMax = options.timeMax;
        const res = await cal.events.list(params);
        const items = res.data.items || [];
        allEvents.push(...items);
      } catch (err) {
        console.log(`[calendar] Failed to query calendar ${calId}:`, err instanceof Error ? err.message : String(err));
      }
    }

    allEvents.sort((a: any, b: any) => {
      const aTime = a.start?.dateTime || a.start?.date || "";
      const bTime = b.start?.dateTime || b.start?.date || "";
      return aTime.localeCompare(bTime);
    });

    const events = allEvents.slice(0, maxResults);
    console.log(`[calendar] Found ${allEvents.length} event(s), returning ${events.length}`);

    if (events.length === 0) return "No upcoming events found.";

    const lines = events.map((event: any, i: number) => {
      const start = event.start?.dateTime
        ? new Date(event.start.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : event.start?.date || "TBD";
      const end = event.end?.dateTime
        ? new Date(event.end.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })
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

export async function listEventsStructured(options?: { maxResults?: number; timeMin?: string; timeMax?: string }): Promise<Array<{ title: string; time: string; calendar: string }>> {
  try {
    const cal = await getCalendarClient();
    const now = new Date();
    const timeMin = options?.timeMin || now.toISOString();
    const maxResults = options?.maxResults || 10;

    let calendars: Array<{ id: string; name: string }> = [{ id: "primary", name: "Rickin" }];
    try {
      const calList = await cal.calendarList.list({ minAccessRole: "reader" });
      const items = calList.data.items || [];
      if (items.length > 0) {
        calendars = items
          .filter((c: any) => c.selected !== false && c.id)
          .map((c: any) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id }));
        if (calendars.length === 0) calendars = [{ id: "primary", name: "Rickin" }];
      }
    } catch {}

    const allEvents: Array<{ event: any; calName: string }> = [];
    for (const c of calendars) {
      try {
        const params: any = { calendarId: c.id, timeMin, maxResults, singleEvents: true, orderBy: "startTime" };
        if (options?.timeMax) params.timeMax = options.timeMax;
        const res = await cal.events.list(params);
        for (const ev of (res.data.items || [])) {
          allEvents.push({ event: ev, calName: c.name });
        }
      } catch {}
    }

    allEvents.sort((a, b) => {
      const aT = a.event.start?.dateTime || a.event.start?.date || "";
      const bT = b.event.start?.dateTime || b.event.start?.date || "";
      return aT.localeCompare(bT);
    });

    return allEvents.slice(0, maxResults).map(({ event, calName }) => {
      const start = event.start?.dateTime
        ? new Date(event.start.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : event.start?.date || "TBD";
      const end = event.end?.dateTime
        ? new Date(event.end.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })
        : "";
      return {
        title: event.summary || "(No title)",
        time: `${start}${end ? " - " + end : ""}`,
        calendar: calName,
      };
    });
  } catch (err) {
    console.error("[calendar] listEventsStructured error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function listCalendars(): Promise<Array<{ id: string; name: string; accessRole: string }>> {
  try {
    const cal = await getCalendarClient();
    const calList = await cal.calendarList.list({ minAccessRole: "reader" });
    const items = calList.data.items || [];
    return items
      .filter((c: any) => c.id)
      .map((c: any) => ({
        id: c.id,
        name: c.summaryOverride || c.summary || c.id,
        accessRole: c.accessRole || "reader",
      }));
  } catch (err) {
    console.error("[calendar] listCalendars error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function fuzzyMatchCalendar(calendars: Array<{ id: string; name: string }>, query: string): string {
  const q = query.toLowerCase().trim();
  const exact = calendars.find(c => c.name.toLowerCase() === q);
  if (exact) return exact.id;
  const starts = calendars.find(c => c.name.toLowerCase().startsWith(q));
  if (starts) return starts.id;
  const contains = calendars.find(c => c.name.toLowerCase().includes(q));
  if (contains) return contains.id;
  return "primary";
}

export async function createEvent(summary: string, options: { startTime: string; endTime?: string; description?: string; location?: string; allDay?: boolean; calendarName?: string }): Promise<string> {
  try {
    const calendar = await getCalendarClient();

    let targetCalendarId = "primary";
    let targetCalendarName = "primary";
    if (options.calendarName && options.calendarName.trim()) {
      const cals = await listCalendars();
      if (cals.length === 0) {
        return `Unable to create event: could not retrieve calendar list to match "${options.calendarName}". Try again or omit calendarName to use the primary calendar.`;
      }
      const writableCals = cals.filter(c => c.accessRole === "owner" || c.accessRole === "writer");
      const matchedId = fuzzyMatchCalendar(writableCals, options.calendarName);
      if (matchedId === "primary") {
        const readOnlyMatch = fuzzyMatchCalendar(cals, options.calendarName);
        if (readOnlyMatch !== "primary") {
          const roName = cals.find(c => c.id === readOnlyMatch)?.name || readOnlyMatch;
          return `Cannot create event on "${roName}" — it is read-only. Available writable calendars: ${writableCals.map(c => c.name).join(", ")}`;
        }
      }
      targetCalendarId = matchedId;
      const matched = writableCals.find(c => c.id === targetCalendarId);
      targetCalendarName = matched ? matched.name : targetCalendarId;
    }

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
      calendarId: targetCalendarId,
      requestBody: event,
    });

    const created = res.data;
    const startStr = created.start?.dateTime
      ? new Date(created.start.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : created.start?.date || "";

    const calLabel = targetCalendarId !== "primary" ? ` on calendar "${targetCalendarName}"` : "";
    return `Created event: "${summary}" on ${startStr}${calLabel}`;
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

export async function findOrCreateCalendar(name: string): Promise<string> {
  const cal = await getCalendarClient();
  const list = await cal.calendarList.list({ minAccessRole: "owner" });
  const existing = (list.data.items || []).find(
    (c: any) => (c.summaryOverride || c.summary || "").toLowerCase() === name.toLowerCase()
  );
  if (existing?.id) return existing.id;

  const res = await cal.calendars.insert({ requestBody: { summary: name, timeZone: "America/New_York" } });
  return res.data.id!;
}

export async function createRecurringEvent(calendarId: string, options: {
  summary: string;
  date: string;
  description?: string;
  colorId?: string;
  recurrence?: string[];
  reminders?: { useDefault: boolean; overrides?: Array<{ method: string; minutes: number }> };
}): Promise<string> {
  const cal = await getCalendarClient();
  const d = new Date(options.date);
  d.setDate(d.getDate() + 1);
  const endDate = d.toISOString().split("T")[0];

  const event: any = {
    summary: options.summary,
    start: { date: options.date },
    end: { date: endDate },
  };
  if (options.description) event.description = options.description;
  if (options.colorId) event.colorId = options.colorId;
  if (options.recurrence) event.recurrence = options.recurrence;
  if (options.reminders) event.reminders = options.reminders;

  const res = await cal.events.insert({ calendarId, requestBody: event });
  return res.data.id || "created";
}
