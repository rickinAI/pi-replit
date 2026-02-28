import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import cookieParser from "cookie-parser";
import crypto from "crypto";

import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import * as obsidian from "./src/obsidian.js";
import * as conversations from "./src/conversations.js";
import * as gmail from "./src/gmail.js";
import * as calendar from "./src/calendar.js";
import * as weather from "./src/weather.js";
import * as websearch from "./src/websearch.js";
import * as tasks from "./src/tasks.js";
import * as news from "./src/news.js";
import * as twitter from "./src/twitter.js";
import * as stocks from "./src/stocks.js";
import * as maps from "./src/maps.js";
import * as alerts from "./src/alerts.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = __filename.includes("/dist/") ? path.resolve(__dirname, "..") : __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const AGENT_DIR = path.join(PROJECT_ROOT, ".pi/agent");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "conversations");

fs.mkdirSync(AGENT_DIR, { recursive: true });
conversations.init(DATA_DIR);
gmail.init(PROJECT_ROOT);
calendar.init(PROJECT_ROOT);
tasks.init(PROJECT_ROOT);
alerts.init(PROJECT_ROOT);

if (!ANTHROPIC_KEY) console.warn("ANTHROPIC_API_KEY is not set.");
if (!obsidian.isConfigured()) console.warn("Knowledge base integration not configured.");
if (!gmail.isConfigured()) console.warn("Gmail integration not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing).");
else if (!gmail.isConnected()) console.warn("Gmail configured but not yet authorized. Visit /api/gmail/auth to connect.");
else {
  gmail.getConnectedEmail().then(email => {
    if (email) console.log(`[boot] Google account connected: ${email}`);
  }).catch(() => {});
}
if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set — auth disabled.");

console.log(`[boot] PORT=${PORT} PUBLIC_DIR=${PUBLIC_DIR} AGENT_DIR=${AGENT_DIR}`);
console.log(`[boot] public/ exists: ${fs.existsSync(PUBLIC_DIR)}`);

function buildKnowledgeBaseTools(): ToolDefinition[] {
  if (!obsidian.isConfigured()) return [];

  return [
    {
      name: "notes_list",
      label: "Notes List",
      description: "List files and folders in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path inside the knowledge base. Defaults to root." })),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.listNotes(params.path ?? "/");
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "notes_read",
      label: "Notes Read",
      description: "Read the markdown content of a note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note, e.g. 'Daily Notes/2025-01-15.md'" }),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.readNote(params.path);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "notes_create",
      label: "Notes Create",
      description: "Create or overwrite a note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path for the new note, e.g. 'Ideas/new-idea.md'" }),
        content: Type.String({ description: "Markdown content for the note" }),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.createNote(params.path, params.content);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "notes_append",
      label: "Notes Append",
      description: "Append content to the end of an existing note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note to append to" }),
        content: Type.String({ description: "Markdown content to append" }),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.appendToNote(params.path, params.content);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "notes_search",
      label: "Notes Search",
      description: "Search for text across all notes in the user's knowledge base. Returns matching notes and snippets.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query string" }),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.searchNotes(params.query);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildGmailTools(): ToolDefinition[] {
  if (!gmail.isConfigured()) return [];

  return [
    {
      name: "email_list",
      label: "Email List",
      description: "List recent emails from the user's inbox. Optionally filter with a Gmail search query (e.g. 'is:unread', 'from:someone@example.com', 'subject:meeting').",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Gmail search query to filter emails. Uses Gmail search syntax." })),
        maxResults: Type.Optional(Type.Number({ description: "Maximum number of emails to return (default 10, max 20)." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.listEmails(params.query, params.maxResults ?? 10);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_read",
      label: "Email Read",
      description: "Read the full content of a specific email by its message ID. Use email_list first to find the ID.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to read (from email_list results)." }),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.readEmail(params.messageId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_search",
      label: "Email Search",
      description: "Search emails using Gmail search syntax. Supports queries like 'from:name subject:topic after:2025/01/01 has:attachment'.",
      parameters: Type.Object({
        query: Type.String({ description: "Gmail search query string." }),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.searchEmails(params.query);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildWeatherTools(): ToolDefinition[] {
  return [
    {
      name: "weather_get",
      label: "Weather",
      description: "Get current weather conditions and 3-day forecast for a location. Use city names, zip codes, or landmarks.",
      parameters: Type.Object({
        location: Type.String({ description: "Location to get weather for (e.g. 'New York', '90210', 'Tokyo')" }),
      }),
      async execute(_toolCallId, params) {
        const result = await weather.getWeather(params.location);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildSearchTools(): ToolDefinition[] {
  return [
    {
      name: "web_search",
      label: "Web Search",
      description: "Search the web for real-time information. Returns top results with titles, snippets, and URLs.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
      }),
      async execute(_toolCallId, params) {
        const result = await websearch.search(params.query);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildCalendarTools(): ToolDefinition[] {
  if (!calendar.isConfigured()) return [];

  return [
    {
      name: "calendar_list",
      label: "Calendar Events",
      description: "List upcoming calendar events. Can filter by date range.",
      parameters: Type.Object({
        maxResults: Type.Optional(Type.Number({ description: "Maximum number of events to return (default 10)" })),
        timeMin: Type.Optional(Type.String({ description: "Start of date range in ISO 8601 format (defaults to now)" })),
        timeMax: Type.Optional(Type.String({ description: "End of date range in ISO 8601 format" })),
      }),
      async execute(_toolCallId, params) {
        const result = await calendar.listEvents(params);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "calendar_create",
      label: "Create Event",
      description: "Create a new calendar event.",
      parameters: Type.Object({
        summary: Type.String({ description: "Event title" }),
        startTime: Type.String({ description: "Start time in ISO 8601 format (e.g. '2025-03-15T14:00:00')" }),
        endTime: Type.Optional(Type.String({ description: "End time in ISO 8601 format (defaults to 1 hour after start)" })),
        description: Type.Optional(Type.String({ description: "Event description" })),
        location: Type.Optional(Type.String({ description: "Event location" })),
        allDay: Type.Optional(Type.Boolean({ description: "Whether this is an all-day event" })),
      }),
      async execute(_toolCallId, params) {
        const { summary, ...options } = params;
        const result = await calendar.createEvent(summary, options);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildTaskTools(): ToolDefinition[] {
  return [
    {
      name: "task_add",
      label: "Add Task",
      description: "Add a new task or to-do item with optional due date, priority, and tags.",
      parameters: Type.Object({
        title: Type.String({ description: "Task title" }),
        description: Type.Optional(Type.String({ description: "Task description or details" })),
        dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD format" })),
        priority: Type.Optional(Type.String({ description: "Priority: 'low', 'medium', or 'high' (default: medium)" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
      }),
      async execute(_toolCallId, params) {
        const { title, ...options } = params;
        const result = tasks.addTask(title, options);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "task_list",
      label: "List Tasks",
      description: "List tasks and to-do items. Shows open tasks by default.",
      parameters: Type.Object({
        showCompleted: Type.Optional(Type.Boolean({ description: "Include completed tasks (default: false)" })),
        tag: Type.Optional(Type.String({ description: "Filter by tag" })),
        priority: Type.Optional(Type.String({ description: "Filter by priority: 'low', 'medium', 'high'" })),
      }),
      async execute(_toolCallId, params) {
        const result = tasks.listTasks(params);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "task_complete",
      label: "Complete Task",
      description: "Mark a task as completed.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to complete" }),
      }),
      async execute(_toolCallId, params) {
        const result = tasks.completeTask(params.taskId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "task_delete",
      label: "Delete Task",
      description: "Delete a task permanently.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to delete" }),
      }),
      async execute(_toolCallId, params) {
        const result = tasks.deleteTask(params.taskId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "task_update",
      label: "Update Task",
      description: "Update an existing task's details.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to update" }),
        title: Type.Optional(Type.String({ description: "New title" })),
        description: Type.Optional(Type.String({ description: "New description" })),
        dueDate: Type.Optional(Type.String({ description: "New due date in YYYY-MM-DD format" })),
        priority: Type.Optional(Type.String({ description: "New priority: 'low', 'medium', 'high'" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "New tags" })),
      }),
      async execute(_toolCallId, params) {
        const { taskId, ...updates } = params;
        const result = tasks.updateTask(taskId, updates);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildNewsTools(): ToolDefinition[] {
  return [
    {
      name: "news_headlines",
      label: "News Headlines",
      description: "Get latest news headlines by category. Categories: top, world, business, technology, science, health, sports, entertainment.",
      parameters: Type.Object({
        category: Type.Optional(Type.String({ description: "News category (default: 'top'). Options: top, world, business, technology, science, health, sports, entertainment" })),
      }),
      async execute(_toolCallId, params) {
        const result = await news.getNews(params.category);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "news_search",
      label: "Search News",
      description: "Search for news articles about a specific topic.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query for news articles" }),
      }),
      async execute(_toolCallId, params) {
        const result = await news.searchNews(params.query);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildTwitterTools(): ToolDefinition[] {
  return [
    {
      name: "x_user_profile",
      label: "X User Profile",
      description: "Get an X (Twitter) user's profile info including bio, follower count, and stats. Accepts a username or profile URL.",
      parameters: Type.Object({
        username: Type.String({ description: "X username (e.g. 'elonmusk') or profile URL" }),
      }),
      async execute(_toolCallId, params) {
        const result = await twitter.getUserProfile(params.username);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "x_read_tweet",
      label: "Read Tweet",
      description: "Read the full content of a specific tweet/post. Accepts a tweet URL (x.com or twitter.com) or tweet ID.",
      parameters: Type.Object({
        tweet: Type.String({ description: "Tweet URL (e.g. 'https://x.com/user/status/123') or tweet ID" }),
      }),
      async execute(_toolCallId, params) {
        const result = await twitter.getTweet(params.tweet);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "x_user_timeline",
      label: "X Timeline",
      description: "Read recent tweets/posts from an X (Twitter) user's timeline. Returns their latest public posts.",
      parameters: Type.Object({
        username: Type.String({ description: "X username (e.g. 'elonmusk') or profile URL" }),
        count: Type.Optional(Type.Number({ description: "Number of tweets to fetch (default 10, max 20)" })),
      }),
      async execute(_toolCallId, params) {
        const result = await twitter.getUserTimeline(params.username, params.count ?? 10);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildStockTools(): ToolDefinition[] {
  return [
    {
      name: "stock_quote",
      label: "Stock Quote",
      description: "Get real-time stock price, change, and stats for a ticker symbol. Use standard stock symbols (e.g. AAPL, TSLA, MSFT, GOOGL, AMZN).",
      parameters: Type.Object({
        symbol: Type.String({ description: "Stock ticker symbol (e.g. 'AAPL', 'TSLA', 'MSFT')" }),
      }),
      async execute(_toolCallId, params) {
        const result = await stocks.getStockQuote(params.symbol);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "crypto_price",
      label: "Crypto Price",
      description: "Get real-time cryptocurrency price, 24h/7d change, market cap, and volume. Supports common tickers (BTC, ETH, SOL, etc.) and full names (bitcoin, ethereum, etc.).",
      parameters: Type.Object({
        coin: Type.String({ description: "Cryptocurrency name or ticker (e.g. 'bitcoin', 'BTC', 'ethereum', 'ETH', 'solana')" }),
      }),
      async execute(_toolCallId, params) {
        const result = await stocks.getCryptoPrice(params.coin);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildMapsTools(): ToolDefinition[] {
  return [
    {
      name: "maps_directions",
      label: "Directions",
      description: "Get directions between two locations with distance, estimated time, and turn-by-turn steps. Supports driving, walking, and cycling.",
      parameters: Type.Object({
        from: Type.String({ description: "Starting location (address, place name, or landmark)" }),
        to: Type.String({ description: "Destination location (address, place name, or landmark)" }),
        mode: Type.Optional(Type.String({ description: "Travel mode: 'driving' (default), 'walking', or 'cycling'" })),
      }),
      async execute(_toolCallId, params) {
        const result = await maps.getDirections(params.from, params.to, params.mode);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "maps_search_places",
      label: "Search Places",
      description: "Search for places, businesses, or addresses. Optionally search near a specific location.",
      parameters: Type.Object({
        query: Type.String({ description: "What to search for (e.g. 'coffee shops', 'gas stations', 'Central Park')" }),
        near: Type.Optional(Type.String({ description: "Search near this location (e.g. 'Manhattan, NY', 'San Francisco')" })),
      }),
      async execute(_toolCallId, params) {
        const result = await maps.searchPlaces(params.query, params.near);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildInterviewTool(sessionId: string): ToolDefinition[] {
  return [
    {
      name: "interview",
      label: "Interview",
      description:
        "Ask the user structured clarification questions via an interactive form. Use this when you need specific choices, preferences, or detailed context from the user before proceeding. Supports single-select (pick one), multi-select (pick many), text (free input), and info (display-only context). The form appears inline in the chat. Returns the user's responses as key-value pairs.",
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: "Title shown at the top of the form" })),
        description: Type.Optional(Type.String({ description: "Brief description or context for the form" })),
        questions: Type.Array(
          Type.Object({
            id: Type.String({ description: "Unique identifier for this question" }),
            type: Type.Union([
              Type.Literal("single"),
              Type.Literal("multi"),
              Type.Literal("text"),
              Type.Literal("info"),
            ], { description: "Question type: single (radio), multi (checkbox), text (free input), info (display only)" }),
            question: Type.String({ description: "The question text to display" }),
            options: Type.Optional(Type.Array(Type.String(), { description: "Options for single/multi select questions" })),
            recommended: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Recommended option(s) shown with a badge" })),
            context: Type.Optional(Type.String({ description: "Additional helper text shown below the question" })),
          }),
          { description: "Array of questions to ask the user" }
        ),
      }),
      async execute(toolCallId, params) {
        const entry = sessions.get(sessionId);
        if (!entry) {
          return { content: [{ type: "text" as const, text: "Session expired." }], details: {} };
        }

        if (entry.interviewWaiter) {
          return { content: [{ type: "text" as const, text: "An interview form is already active. Wait for the user to respond before sending another." }], details: {} };
        }

        const interviewEvent = JSON.stringify({
          type: "interview_form",
          toolCallId,
          title: params.title,
          description: params.description,
          questions: params.questions,
        });
        for (const sub of entry.subscribers) {
          try { sub.write(`data: ${interviewEvent}\n\n`); } catch {}
        }

        const responses = await new Promise<any[]>((resolve) => {
          const timer = setTimeout(() => {
            if (entry.interviewWaiter) {
              entry.interviewWaiter = undefined;
              const timeoutEvent = JSON.stringify({ type: "interview_timeout" });
              for (const sub of entry.subscribers) {
                try { sub.write(`data: ${timeoutEvent}\n\n`); } catch {}
              }
              resolve([]);
            }
          }, 5 * 60 * 1000);

          entry.interviewWaiter = { resolve, reject: () => {}, timer };
        });

        if (responses.length === 0) {
          return {
            content: [{ type: "text" as const, text: "The user did not respond to the interview form (timed out after 5 minutes). You can ask them directly in chat instead." }],
            details: { timedOut: true },
          };
        }

        const formatted = responses
          .map(r => `**${r.id}**: ${Array.isArray(r.value) ? r.value.join(", ") : r.value}`)
          .join("\n");

        return {
          content: [{ type: "text" as const, text: formatted }],
          details: { responses },
        };
      },
    },
  ];
}

function buildConversationTools(): ToolDefinition[] {
  return [
    {
      name: "conversation_search",
      label: "Conversation Search",
      description: "Search past conversations with the user by keyword. Use this when the user asks about previous discussions, e.g. 'what did we talk about last Tuesday?' or 'find our conversation about the trip'. Returns matching conversations with context snippets.",
      parameters: Type.Object({
        query: Type.String({ description: "Search keywords to find in past conversations" }),
        days_ago: Type.Optional(Type.Number({ description: "Only search conversations from the last N days. E.g. 7 for last week." })),
      }),
      async execute(_toolCallId, params) {
        const after = params.days_ago ? Date.now() - params.days_ago * 24 * 60 * 60 * 1000 : undefined;
        const results = conversations.search(params.query, { after, limit: 8 });

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No past conversations found matching "${params.query}".` }], details: {} };
        }

        const formatted = results.map(r => {
          const date = new Date(r.createdAt).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
          const snippetText = r.snippets.map(s => `  ${s}`).join("\n");
          return `**"${r.title}"** (${date}, ${r.messageCount} msgs)\n${snippetText}`;
        }).join("\n\n---\n\n");

        return { content: [{ type: "text" as const, text: formatted }], details: {} };
      },
    },
  ];
}

type ModelMode = "auto" | "fast" | "full";

interface InterviewWaiter {
  resolve: (responses: any[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SessionEntry {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  subscribers: Set<Response>;
  createdAt: number;
  conversation: conversations.Conversation;
  currentAgentText: string;
  modelMode: ModelMode;
  activeModelName: string;
  interviewWaiter?: InterviewWaiter;
}
const sessions = new Map<string, SessionEntry>();

const FAST_MODEL_ID = "claude-haiku-4-5";
const FULL_MODEL_ID = "claude-sonnet-4-6";

const FAST_PATTERNS = [
  /^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|thanks|thank you|ok|okay|got it|cool|nice|great)\b/i,
  /^what('s| is) (the )?(time|date|day)\b/i,
  /^(show|check|get|list|read)\s+(my\s+)?(tasks?|todos?|email|calendar|events?|weather|stock|price|portfolio|watchlist|notes?)\b/i,
  /^(add|create|complete|delete|remove)\s+(a\s+)?(task|todo|note)\b/i,
  /^(how'?s|what'?s)\s+(the\s+)?(weather|market|stock)\b/i,
  /^(remind|timer|alarm|set)\b/i,
];

function classifyIntent(message: string): "fast" | "full" {
  const trimmed = message.trim();
  if (trimmed.length < 80) {
    for (const pattern of FAST_PATTERNS) {
      if (pattern.test(trimmed)) return "fast";
    }
  }
  if (trimmed.length < 20 && !trimmed.includes("?")) return "fast";
  return "full";
}

const syncedConversations = new Set<string>();

function saveAndCleanSession(id: string) {
  const entry = sessions.get(id);
  if (!entry) return;
  if (entry.currentAgentText) {
    conversations.addMessage(entry.conversation, "agent", entry.currentAgentText);
    entry.currentAgentText = "";
  }
  if (entry.conversation.messages.length > 0) {
    conversations.save(entry.conversation);
    syncConversationToVault(entry.conversation);
  }
  for (const sub of entry.subscribers) { try { sub.end(); } catch {} }
  entry.subscribers.clear();
  sessions.delete(id);
}

async function syncConversationToVault(conv: conversations.Conversation) {
  if (syncedConversations.has(conv.id)) return;
  if (!conversations.shouldSync(conv)) return;
  if (!obsidian.isConfigured()) return;

  const existing = conversations.load(conv.id);
  if (existing && (existing as any).syncedAt) {
    syncedConversations.add(conv.id);
    return;
  }

  try {
    const summary = conversations.generateSummaryMarkdown(conv);
    const dateStr = new Date(conv.createdAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    let safeTitle = conv.title.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 50).trim();
    if (!safeTitle) safeTitle = conv.id;
    const notePath = `Conversations/${dateStr} - ${safeTitle}.md`;
    await obsidian.createNote(notePath, summary);
    syncedConversations.add(conv.id);
    (conv as any).syncedAt = Date.now();
    conversations.save(conv);
    console.log(`[sync] Conversation synced to vault: ${notePath}`);
  } catch (err) {
    console.error(`[sync] Failed to sync conversation ${conv.id}:`, err);
  }
}

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of sessions.entries()) {
    if (entry.createdAt < cutoff) {
      saveAndCleanSession(id);
    }
  }
}, 10 * 60 * 1000);

setInterval(() => {
  for (const entry of sessions.values()) {
    if (entry.currentAgentText) {
      conversations.addMessage(entry.conversation, "agent", entry.currentAgentText);
      entry.currentAgentText = "";
    }
    if (entry.conversation.messages.length > 0) {
      conversations.save(entry.conversation);
    }
  }
}, 5 * 60 * 1000);

const TUNNEL_URL_FILE = path.join(PROJECT_ROOT, "data", "tunnel-url.txt");
function loadPersistedTunnelUrl(): string | null {
  try { return fs.readFileSync(TUNNEL_URL_FILE, "utf-8").trim() || null; } catch { return null; }
}
function persistTunnelUrl(url: string) {
  try { fs.writeFileSync(TUNNEL_URL_FILE, url, "utf-8"); } catch {}
}

(function initTunnelUrl() {
  const envUrl = process.env.OBSIDIAN_API_URL || "";
  const savedUrl = loadPersistedTunnelUrl();
  if (savedUrl && savedUrl !== envUrl) {
    obsidian.setApiUrl(savedUrl);
    console.log(`[boot] Loaded persisted tunnel URL: ${savedUrl}`);
  }
})();

let lastTunnelStatus = true;
if (obsidian.isConfigured()) {
  setInterval(async () => {
    const alive = await obsidian.ping();
    if (alive && !lastTunnelStatus) {
      console.log("[health] Knowledge base connection recovered");
    } else if (!alive && lastTunnelStatus) {
      console.warn("[health] Knowledge base connection DOWN — check that Obsidian is running and tunnel service is active");
    }
    lastTunnelStatus = alive;
  }, 2 * 60 * 1000);

  obsidian.ping().then(ok => {
    console.log(`[health] Knowledge base: ${ok ? "connected" : "offline"}`);
    lastTunnelStatus = ok;
  });
}

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser(SESSION_SECRET));

const AUTH_PUBLIC_PATHS = new Set(["/login.html", "/login.css", "/api/login", "/health", "/manifest.json", "/icons/icon-180.png", "/icons/icon-192.png", "/icons/icon-512.png", "/api/healthcheck"]);

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!APP_PASSWORD) { next(); return; }
  if (AUTH_PUBLIC_PATHS.has(req.path)) { next(); return; }
  if (req.path === "/api/config/tunnel-url") { next(); return; }
  if (req.path === "/api/gmail/callback") { next(); return; }
  if (req.path === "/api/gmail/auth") { next(); return; }

  const token = req.signedCookies?.auth;
  if (token === "authenticated") { next(); return; }

  if (req.path === "/" && !req.headers.accept?.includes("text/html")) {
    res.status(200).send("ok");
  } else if (req.headers.accept?.includes("text/html") || req.path === "/") {
    res.redirect("/login.html");
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}

app.use(authMiddleware);

app.post("/api/login", (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
  if (!password || password !== APP_PASSWORD) {
    res.status(401).json({ error: "ACCESS DENIED" });
    return;
  }
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("auth", "authenticated", {
    signed: true,
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.get("/api/logout", (_req: Request, res: Response) => {
  res.clearCookie("auth");
  res.redirect("/login.html");
});

app.use(express.static(PUBLIC_DIR));


app.get("/api/gmail/auth", (_req: Request, res: Response) => {
  if (!gmail.isConfigured()) {
    res.status(500).json({ error: "Gmail not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." });
    return;
  }
  const url = gmail.getAuthUrl();
  res.redirect(url);
});

app.get("/api/gmail/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing authorization code.");
    return;
  }
  try {
    await gmail.handleCallback(code);
    res.send(`<html><body style="background:#000;color:#0f0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>[GMAIL CONNECTED]</h2><p>Authorization successful. You can close this tab.</p><script>setTimeout(()=>window.close(),2000)</script></div></body></html>`);
  } catch (err) {
    console.error("Gmail callback error:", err);
    res.status(500).send("Gmail authorization failed. Please try again.");
  }
});

app.get("/api/gmail/status", async (_req: Request, res: Response) => {
  const status: any = {
    configured: gmail.isConfigured(),
    connected: gmail.isConnected(),
  };
  if (status.connected) {
    try {
      status.email = await gmail.getConnectedEmail();
    } catch {}
  }
  res.json(status);
});

app.post("/api/session", async (_req: Request, res: Response) => {
  try {
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const authStorage = AuthStorage.create(path.join(AGENT_DIR, "auth.json"));
    authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);

    const modelRegistry = new ModelRegistry(authStorage, path.join(AGENT_DIR, "models.json"));
    const fullModel = modelRegistry.find("anthropic", FULL_MODEL_ID);
    if (!fullModel) throw new Error(`Model ${FULL_MODEL_ID} not found in registry`);

    const allTools = [
      ...buildKnowledgeBaseTools(),
      ...buildGmailTools(),
      ...buildCalendarTools(),
      ...buildWeatherTools(),
      ...buildSearchTools(),
      ...buildTaskTools(),
      ...buildNewsTools(),
      ...buildTwitterTools(),
      ...buildStockTools(),
      ...buildMapsTools(),
      ...buildConversationTools(),
      ...buildInterviewTool(sessionId),
    ];
    console.log(`[session] ${allTools.length} tools registered`);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

    const resourceLoader = new DefaultResourceLoader({
      cwd: PROJECT_ROOT,
      agentDir: AGENT_DIR,
      settingsManager,
      noSkills: true,
      noExtensions: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      agentDir: AGENT_DIR,
      authStorage,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader,
      modelRegistry,
      model: fullModel,
      tools: [],
      customTools: allTools,
    });

    const conv = conversations.createConversation(sessionId);
    const entry: SessionEntry = {
      session,
      subscribers: new Set(),
      createdAt: Date.now(),
      conversation: conv,
      currentAgentText: "",
      modelMode: "auto",
      activeModelName: FULL_MODEL_ID,
    };
    sessions.set(sessionId, entry);

    session.subscribe((event: AgentSessionEvent) => {
      const data = JSON.stringify(event);
      for (const sub of entry.subscribers) {
        try { sub.write(`data: ${data}\n\n`); } catch {}
      }

      if (event.type === "message_update") {
        const ae = (event as any).assistantMessageEvent;
        if (ae?.type === "text_delta" && ae.delta) {
          entry.currentAgentText += ae.delta;
        }
      }

      if (event.type === "agent_end") {
        if (entry.currentAgentText) {
          conversations.addMessage(entry.conversation, "agent", entry.currentAgentText);
          entry.currentAgentText = "";
        }
      }
    });

    const recentSummary = conversations.getRecentSummary(5);

    res.json({ sessionId, recentContext: recentSummary || null });
  } catch (err) {
    console.error("Failed to create session:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/session/:id/stream", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => { res.write(": heartbeat\n\n"); }, 15_000);
  entry.subscribers.add(res);

  req.on("close", () => {
    clearInterval(heartbeat);
    entry.subscribers.delete(res);
  });
});

app.post("/api/session/:id/prompt", async (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }

  const { message, images } = req.body as { message?: string; images?: Array<{ mimeType: string; data: string }> };
  if (!message?.trim() && (!images || images.length === 0)) { res.status(400).json({ error: "message or images required" }); return; }

  const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const MAX_IMAGES = 5;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  if (images && images.length > MAX_IMAGES) {
    res.status(400).json({ error: `Maximum ${MAX_IMAGES} images allowed` }); return;
  }
  if (images) {
    for (const img of images) {
      if (!ALLOWED_MIME.has(img.mimeType)) {
        res.status(400).json({ error: `Unsupported image type: ${img.mimeType}` }); return;
      }
      const sizeBytes = Math.ceil((img.data.length * 3) / 4);
      if (sizeBytes > MAX_IMAGE_BYTES) {
        res.status(400).json({ error: "Image too large (max 10MB)" }); return;
      }
    }
  }

  const text = message?.trim() || "(image attached)";
  const imgAttachments = images?.map(i => ({ mimeType: i.mimeType, data: i.data }));
  conversations.addMessage(entry.conversation, "user", text, imgAttachments);

  let chosenModelId = FULL_MODEL_ID;
  if (entry.modelMode === "fast") {
    chosenModelId = FAST_MODEL_ID;
  } else if (entry.modelMode === "auto") {
    const intent = classifyIntent(text);
    chosenModelId = intent === "fast" ? FAST_MODEL_ID : FULL_MODEL_ID;
  }

  if (chosenModelId !== entry.activeModelName) {
    try {
      const authStorage = AuthStorage.create(path.join(AGENT_DIR, "auth.json"));
      authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);
      const modelRegistry = new ModelRegistry(authStorage, path.join(AGENT_DIR, "models.json"));
      const newModel = modelRegistry.find("anthropic", chosenModelId);
      if (newModel) {
        await entry.session.setModel(newModel);
        entry.activeModelName = chosenModelId;
      } else {
        console.warn(`[model] ${chosenModelId} not found, staying on ${entry.activeModelName}`);
        chosenModelId = entry.activeModelName;
      }
    } catch (err) {
      console.error(`[model] Failed to switch to ${chosenModelId}:`, err);
      chosenModelId = entry.activeModelName;
    }
  }

  const modelEvent = JSON.stringify({ type: "model_info", model: entry.activeModelName });
  for (const sub of entry.subscribers) {
    try { sub.write(`data: ${modelEvent}\n\n`); } catch {}
  }

  res.json({ ok: true });

  try {
    const promptImages = images?.map(i => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
    await entry.session.prompt(text, promptImages ? { images: promptImages } : undefined);
  } catch (err) {
    console.error("Prompt error:", err);
    const errEvent = JSON.stringify({ type: "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try { sub.write(`data: ${errEvent}\n\n`); } catch {}
    }
  }
});

app.put("/api/session/:id/model-mode", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }
  const { mode } = req.body as { mode?: string };
  if (!mode || !["auto", "fast", "full"].includes(mode)) {
    res.status(400).json({ error: "mode must be auto, fast, or full" }); return;
  }
  entry.modelMode = mode as ModelMode;
  console.log(`[model] Session ${req.params["id"]} mode set to: ${mode}`);
  res.json({ ok: true, mode, activeModel: entry.activeModelName });
});

app.get("/api/session/:id/model-mode", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }
  res.json({ mode: entry.modelMode, activeModel: entry.activeModelName });
});

app.post("/api/session/:id/interview-response", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }

  const { responses } = req.body as { responses?: any[] };
  if (!responses || !Array.isArray(responses)) {
    res.status(400).json({ error: "responses array required" }); return;
  }

  if (entry.interviewWaiter) {
    clearTimeout(entry.interviewWaiter.timer);
    entry.interviewWaiter.resolve(responses);
    entry.interviewWaiter = undefined;
    console.log(`[interview] Received ${responses.length} responses for session ${req.params["id"]}`);
  }

  res.json({ ok: true });
});

app.delete("/api/session/:id", (req: Request, res: Response) => {
  saveAndCleanSession(req.params["id"] as string);
  res.json({ ok: true });
});

app.get("/api/conversations/search", (req: Request, res: Response) => {
  const q = (req.query["q"] as string) || "";
  if (!q.trim()) { res.json([]); return; }
  const before = req.query["before"] ? Number(req.query["before"]) : undefined;
  const after = req.query["after"] ? Number(req.query["after"]) : undefined;
  const results = conversations.search(q, { before, after });
  res.json(results);
});

app.get("/api/conversations", (_req: Request, res: Response) => {
  res.json(conversations.list());
});

app.get("/api/conversations/:id", (req: Request, res: Response) => {
  const conv = conversations.load(req.params["id"] as string);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  res.json(conv);
});

app.delete("/api/conversations/:id", (req: Request, res: Response) => {
  conversations.remove(req.params["id"] as string);
  res.json({ ok: true });
});


app.post("/api/config/tunnel-url", (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.OBSIDIAN_API_KEY}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { url } = req.body as { url?: string };
  if (!url?.startsWith("https://")) {
    res.status(400).json({ error: "url must be an https:// URL" });
    return;
  }
  obsidian.setApiUrl(url);
  persistTunnelUrl(url);
  console.log(`Tunnel URL updated to: ${url}`);
  res.json({ ok: true, url });
});

app.get("/api/alerts/config", (_req: Request, res: Response) => {
  res.json(alerts.getConfig());
});

app.put("/api/alerts/config", (req: Request, res: Response) => {
  const updated = alerts.updateConfig(req.body);
  res.json(updated);
});

app.post("/api/alerts/trigger/:type", async (req: Request, res: Response) => {
  const type = req.params["type"] as string;
  if (!["morning", "afternoon", "evening"].includes(type)) {
    res.status(400).json({ error: "Invalid brief type. Use morning, afternoon, or evening." });
    return;
  }
  try {
    const event = await alerts.triggerBrief(type as "morning" | "afternoon" | "evening");
    res.json({ ok: true, event });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

let glanceCache: { data: any; ts: number } | null = null;
const GLANCE_TTL = 5 * 60 * 1000;

app.get("/api/glance", async (_req: Request, res: Response) => {
  try {
    if (glanceCache && Date.now() - glanceCache.ts < GLANCE_TTL) {
      res.json(glanceCache.data);
      return;
    }

    const cfg = alerts.getConfig();
    const tz = cfg.timezone || "America/New_York";
    const loc = cfg.location || "10016";
    const now = new Date();
    let timeStr: string;
    try {
      timeStr = now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", weekday: "short", month: "short", day: "numeric" });
    } catch {
      timeStr = now.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", weekday: "short", month: "short", day: "numeric" });
    }

    const result: any = { time: timeStr, weather: null, emails: null, tasks: null, nextEvent: null };

    const promises: Promise<void>[] = [];

    promises.push((async () => {
      try {
        const raw = await weather.getWeather(loc);
        const tempMatch = raw.match(/Temperature:\s*([\d.-]+)°C\s*\((\d+)°F\)/);
        const condMatch = raw.match(/Condition:\s*(.+)/);
        if (tempMatch && condMatch) {
          const condition = condMatch[1].trim();
          const etHour = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).getHours();
          const isNight = etHour >= 18 || etHour < 6;
          let icon = "🌡️";
          const cl = condition.toLowerCase();
          if (cl.includes("clear") || cl.includes("sunny")) icon = isNight ? "🌙" : "☀️";
          else if (cl.includes("partly")) icon = isNight ? "☁️" : "⛅";
          else if (cl.includes("cloud") || cl.includes("overcast")) icon = "☁️";
          else if (cl.includes("rain") || cl.includes("drizzle") || cl.includes("shower")) icon = "🌧️";
          else if (cl.includes("snow")) icon = "❄️";
          else if (cl.includes("thunder")) icon = "⛈️";
          else if (cl.includes("fog")) icon = "🌫️";
          result.weather = { tempC: Math.round(parseFloat(tempMatch[1])), condition, icon };
        }
      } catch {}
    })());

    if (gmail.isConfigured() && gmail.isConnected()) {
      promises.push((async () => {
        try {
          const raw = await gmail.listEmails("is:unread", 20);
          if (raw.includes("No emails found") || raw.includes("empty")) {
            result.emails = { unread: 0 };
          } else {
            const countMatch = raw.match(/\((\d+)\)/);
            result.emails = { unread: countMatch ? parseInt(countMatch[1]) : 0 };
          }
        } catch {}
      })());
    }

    promises.push((async () => {
      try {
        const raw = tasks.listTasks();
        if (raw.includes("No open tasks") || raw.includes("No tasks found")) {
          result.tasks = { active: 0 };
        } else {
          const countMatch = raw.match(/(\d+)\s*open/);
          result.tasks = { active: countMatch ? parseInt(countMatch[1]) : 0 };
        }
      } catch {}
    })());

    if (calendar.isConfigured()) {
      promises.push((async () => {
        try {
          const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
          const tzStr = now.toLocaleString("en-US", { timeZone: tz });
          const tzOffsetMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
          const nowShifted = new Date(now.getTime() + tzOffsetMs);
          const eodInTz = new Date(Date.UTC(nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate(), 23, 59, 59, 999));
          const endOfDayUTC = new Date(eodInTz.getTime() - tzOffsetMs);
          const raw = await calendar.listEvents({ maxResults: 3, timeMax: endOfDayUTC.toISOString() });
          if (!raw.includes("No upcoming events") && !raw.includes("expired") && !raw.includes("not authorized")) {
            const events: Array<{ title: string; time: string }> = [];
            const eventBlocks = raw.split(/\d+\.\s+/).slice(1);
            for (const block of eventBlocks) {
              const lines = block.trim().split("\n");
              const title = lines[0]?.trim() || "";
              const timeLine = lines[1]?.trim() || "";
              if (title) events.push({ title, time: timeLine });
            }
            if (events.length > 0) {
              result.nextEvent = events[0];
              result.upcomingEvents = events.slice(0, 3);
            }
          }
        } catch {}
      })());
    }

    await Promise.all(promises);
    glanceCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch glance data" });
  }
});

app.get("/api/kb-status", (_req, res) => {
  res.json({ online: lastTunnelStatus });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessions.size, ts: Date.now() });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Express error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));

let server = createServer(app);

function gracefulShutdown(signal: string) {
  console.error(`Got ${signal} — closing server...`);
  for (const [id] of sessions.entries()) {
    saveAndCleanSession(id);
  }
  server.close(() => { process.exit(0); });
  setTimeout(() => { process.exit(1); }, 3000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

function startServer(retried = false) {
  if (retried) {
    server = createServer(app);
  }

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && !retried) {
      console.warn(`[boot] Port ${PORT} in use — killing old process and retrying...`);
      import("child_process").then(({ execSync }) => {
        try {
          execSync(`fuser -k -9 ${PORT}/tcp`, { stdio: "ignore" });
        } catch {}
        server.close(() => {});
        setTimeout(() => startServer(true), 2000);
      });
    } else {
      console.error(`[boot] Fatal server error:`, err);
      process.exit(1);
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[ready] pi-replit listening on http://localhost:${PORT}`);

    function broadcastToAll(event: any) {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const entry of sessions.values()) {
        for (const sub of entry.subscribers) {
          try {
            sub.write(data);
          } catch {
            entry.subscribers.delete(sub);
          }
        }
      }
    }

    alerts.startAlertSystem(broadcastToAll);
  });
}

startServer();
