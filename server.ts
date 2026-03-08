import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { execSync, spawn, type ChildProcess } from "child_process";
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
import * as vaultLocal from "./src/vault-local.js";
import * as db from "./src/db.js";
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
import * as gws from "./src/gws.js";
import * as youtube from "./src/youtube.js";
import * as alerts from "./src/alerts.js";
import * as agentLoader from "./src/agents/loader.js";
import { runSubAgent } from "./src/agents/orchestrator.js";
import { extractAndFileInsights } from "./src/memory-extractor.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = __filename.includes("/dist/") ? path.resolve(__dirname, "..") : __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const AGENT_DIR = path.join(PROJECT_ROOT, ".pi/agent");
const VAULT_DIR = path.join(PROJECT_ROOT, "data", "vault");

fs.mkdirSync(AGENT_DIR, { recursive: true });
vaultLocal.init(VAULT_DIR);
agentLoader.init(path.join(PROJECT_ROOT, "data"));

let useLocalVault = vaultLocal.isConfigured();

setInterval(() => {
  const localAvailable = vaultLocal.isConfigured();
  if (localAvailable && !useLocalVault) {
    useLocalVault = true;
    console.log("[health] Knowledge base: switched to local vault (Obsidian Sync)");
  } else if (!localAvailable && useLocalVault) {
    useLocalVault = false;
    if (obsidian.isConfigured()) {
      console.warn("[health] Local vault unavailable — falling back to remote (tunnel)");
    } else {
      console.warn("[health] Local vault unavailable — no remote fallback configured");
    }
  }
}, 15_000);

if (!ANTHROPIC_KEY) console.warn("ANTHROPIC_API_KEY is not set.");
if (useLocalVault) {
  console.log("[boot] Knowledge base: local vault (Obsidian Sync)");
} else if (obsidian.isConfigured()) {
  console.log("[boot] Knowledge base: remote (tunnel)");
} else {
  console.warn("Knowledge base integration not configured.");
}
if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set — auth disabled.");

console.log(`[boot] PORT=${PORT} PUBLIC_DIR=${PUBLIC_DIR} AGENT_DIR=${AGENT_DIR}`);
console.log(`[boot] public/ exists: ${fs.existsSync(PUBLIC_DIR)}`);

function kbList(p: string): Promise<string> {
  return useLocalVault ? vaultLocal.listNotes(p) : obsidian.listNotes(p);
}
function kbRead(p: string): Promise<string> {
  return useLocalVault ? vaultLocal.readNote(p) : obsidian.readNote(p);
}
function kbCreate(p: string, c: string): Promise<string> {
  return useLocalVault ? vaultLocal.createNote(p, c) : obsidian.createNote(p, c);
}
function kbAppend(p: string, c: string): Promise<string> {
  return useLocalVault ? vaultLocal.appendToNote(p, c) : obsidian.appendToNote(p, c);
}
function kbSearch(q: string): Promise<string> {
  return useLocalVault ? vaultLocal.searchNotes(q) : obsidian.searchNotes(q);
}
function kbDelete(p: string): Promise<string> {
  return useLocalVault ? vaultLocal.deleteNote(p) : obsidian.deleteNote(p);
}
function kbMove(from: string, to: string): Promise<string> {
  return useLocalVault ? vaultLocal.moveNote(from, to) : obsidian.moveNote(from, to);
}
function kbRenameFolder(from: string, to: string): Promise<string> {
  return useLocalVault ? vaultLocal.renameFolder(from, to) : obsidian.renameFolder(from, to);
}
function kbListRecursive(p: string): Promise<string> {
  return useLocalVault ? vaultLocal.listRecursive(p) : obsidian.listRecursive(p);
}
function kbFileInfo(p: string): Promise<string> {
  return useLocalVault ? vaultLocal.fileInfo(p) : obsidian.fileInfo(p);
}

function buildKnowledgeBaseTools(): ToolDefinition[] {
  if (!useLocalVault && !obsidian.isConfigured()) return [];

  return [
    {
      name: "notes_list",
      label: "Notes List",
      description: "List files and folders in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path inside the knowledge base. Defaults to root." })),
      }),
      async execute(_toolCallId, params) {
        const p = params.path ?? "/";
        try {
          const result = await kbList(p);
          console.log(`[vault] notes_list OK: ${p}`);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_list FAILED: ${p} — ${err.message}`);
          throw err;
        }
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
        try {
          const result = await kbRead(params.path);
          console.log(`[vault] notes_read OK: ${params.path}`);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_read FAILED: ${params.path} — ${err.message}`);
          throw err;
        }
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
        try {
          const result = await kbCreate(params.path, params.content);
          console.log(`[vault] notes_create OK: ${params.path} (${params.content.length} chars)`);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_create FAILED: ${params.path} — ${err.message}`);
          throw err;
        }
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
        try {
          const result = await kbAppend(params.path, params.content);
          console.log(`[vault] notes_append OK: ${params.path} (+${params.content.length} chars)`);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_append FAILED: ${params.path} — ${err.message}`);
          throw err;
        }
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
        try {
          const result = await kbSearch(params.query);
          const count = JSON.parse(result).length;
          console.log(`[vault] notes_search OK: "${params.query}" (${count} matches)`);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_search FAILED: "${params.query}" — ${err.message}`);
          throw err;
        }
      },
    },
    {
      name: "notes_delete",
      label: "Notes Delete",
      description: "Permanently delete a note from the user's knowledge base. This cannot be undone. Use when reorganizing notes (e.g. after moving content to a new location). Empty parent folders are cleaned up automatically.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note to delete (e.g. 'Projects/old-file.md')" }),
      }),
      async execute(_toolCallId, params) {
        console.log(`[vault] notes_delete: ${params.path}`);
        try {
          const result = await kbDelete(params.path);
          console.log(`[vault] notes_delete OK: ${params.path}`);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_delete FAILED: ${params.path} — ${err.message}`);
          throw err;
        }
      },
    },
    {
      name: "notes_move",
      label: "Notes Move",
      description: "Move or rename a note in the user's knowledge base. Moves the file from one path to another, creating destination folders as needed. Empty source folders are cleaned up automatically.",
      parameters: Type.Object({
        from: Type.String({ description: "Current path of the note (e.g. 'Projects/old-name.md')" }),
        to: Type.String({ description: "New path for the note (e.g. 'Projects/Subfolder/new-name.md')" }),
      }),
      async execute(_toolCallId, params) {
        console.log(`[vault] notes_move: ${params.from} → ${params.to}`);
        try {
          const result = await kbMove(params.from, params.to);
          console.log(`[vault] notes_move OK: ${params.from} → ${params.to}`);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_move FAILED: ${params.from} → ${params.to} — ${err.message}`);
          throw err;
        }
      },
    },
    {
      name: "notes_rename_folder",
      label: "Notes Rename Folder",
      description: "Rename or move an entire folder in the knowledge base. All files and subfolders inside are moved to the new location. Use for reorganizing vault structure.",
      parameters: Type.Object({
        from: Type.String({ description: "Current folder path (e.g. 'Projects/Old Name')" }),
        to: Type.String({ description: "New folder path (e.g. 'Projects/New Name')" }),
      }),
      async execute(_toolCallId, params) {
        console.log(`[vault] notes_rename_folder: ${params.from} → ${params.to}`);
        try {
          const result = await kbRenameFolder(params.from, params.to);
          console.log(`[vault] notes_rename_folder OK: ${params.from} → ${params.to}`);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_rename_folder FAILED: ${params.from} → ${params.to} — ${err.message}`);
          throw err;
        }
      },
    },
    {
      name: "notes_list_recursive",
      label: "Notes List Recursive",
      description: "List all files and subfolders within a folder recursively. Unlike notes_list which only shows one level, this shows the entire tree. Useful for auditing folder structure.",
      parameters: Type.Object({
        path: Type.String({ description: "Folder path to list recursively (e.g. 'Projects/' or '/')" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await kbListRecursive(params.path);
          const count = JSON.parse(result).files?.length ?? 0;
          console.log(`[vault] notes_list_recursive OK: ${params.path} (${count} items)`);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_list_recursive FAILED: ${params.path} — ${err.message}`);
          throw err;
        }
      },
    },
    {
      name: "notes_file_info",
      label: "Notes File Info",
      description: "Get metadata about a note or folder: file size, creation date, and last modified date. Use to identify stale or oversized notes.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the file or folder (e.g. 'Projects/Research.md')" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await kbFileInfo(params.path);
          console.log(`[vault] notes_file_info OK: ${params.path}`);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_file_info FAILED: ${params.path} — ${err.message}`);
          throw err;
        }
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
        const result = await tasks.addTask(title, options);
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
        const result = await tasks.listTasks(params);
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
        const result = await tasks.completeTask(params.taskId);
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
        const result = await tasks.deleteTask(params.taskId);
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
        const result = await tasks.updateTask(taskId, updates);
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
          }, 15 * 60 * 1000);

          entry.interviewWaiter = { resolve, reject: () => {}, timer };
        });

        if (responses.length === 0) {
          return {
            content: [{ type: "text" as const, text: "The user did not respond to the interview form (timed out after 15 minutes). You can ask them directly in chat instead." }],
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

function buildDriveTools(): ToolDefinition[] {
  return [
    {
      name: "drive_list",
      label: "Google Drive List",
      description: "List or search files in Google Drive. Use query parameter for Drive search syntax (e.g. \"name contains 'report'\", \"mimeType='application/vnd.google-apps.folder'\", \"'FOLDER_ID' in parents\"). Without query, returns most recently modified files.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Google Drive search query (Drive API q parameter syntax)" })),
        maxResults: Type.Optional(Type.Number({ description: "Max files to return (default 20)" })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.driveList(params.query, params.maxResults || 20);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "drive_get",
      label: "Google Drive Get",
      description: "Get detailed metadata for a specific file or folder in Google Drive by its ID.",
      parameters: Type.Object({
        fileId: Type.String({ description: "The Google Drive file ID" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.driveGet(params.fileId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "drive_create_folder",
      label: "Google Drive Create Folder",
      description: "Create a new folder in Google Drive. Optionally specify a parent folder ID to create it inside an existing folder.",
      parameters: Type.Object({
        name: Type.String({ description: "Name for the new folder" }),
        parentId: Type.Optional(Type.String({ description: "Parent folder ID (creates at root if omitted)" })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.driveCreateFolder(params.name, params.parentId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "drive_move",
      label: "Google Drive Move",
      description: "Move a file or folder to a different folder in Google Drive.",
      parameters: Type.Object({
        fileId: Type.String({ description: "ID of the file/folder to move" }),
        newParentId: Type.String({ description: "ID of the destination folder" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.driveMove(params.fileId, params.newParentId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "drive_rename",
      label: "Google Drive Rename",
      description: "Rename a file or folder in Google Drive.",
      parameters: Type.Object({
        fileId: Type.String({ description: "ID of the file/folder to rename" }),
        newName: Type.String({ description: "New name for the file/folder" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.driveRename(params.fileId, params.newName);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "drive_delete",
      label: "Google Drive Delete",
      description: "Move a file or folder to trash in Google Drive. This does not permanently delete — it can be recovered from trash.",
      parameters: Type.Object({
        fileId: Type.String({ description: "ID of the file/folder to trash" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.driveDelete(params.fileId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildSheetsTools(): ToolDefinition[] {
  return [
    {
      name: "sheets_list",
      label: "Google Sheets List",
      description: "List all Google Sheets spreadsheets in Drive.",
      parameters: Type.Object({}),
      async execute() {
        const result = await gws.sheetsList();
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_read",
      label: "Google Sheets Read",
      description: "Read data from a Google Sheets spreadsheet. Specify a range like 'Sheet1!A1:D10' or just 'Sheet1' for the whole sheet.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID (from the URL or drive_list)" }),
        range: Type.String({ description: "Cell range to read, e.g. 'Sheet1!A1:D10' or 'Sheet1'" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsRead(params.spreadsheetId, params.range);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_append",
      label: "Google Sheets Append",
      description: "Append one or more rows to a Google Sheets spreadsheet. Each row is an array of cell values.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        values: Type.Array(Type.Array(Type.String()), { description: "Array of rows, each row is an array of cell values. Example: [[\"Name\", \"Age\"], [\"Alice\", \"30\"]]" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsAppend(params.spreadsheetId, params.values);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_update",
      label: "Google Sheets Update",
      description: "Update specific cells in a Google Sheets spreadsheet. Specify the range and new values.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        range: Type.String({ description: "Cell range to update, e.g. 'Sheet1!A1:B2'" }),
        values: Type.Array(Type.Array(Type.String()), { description: "Array of rows with new values" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsUpdate(params.spreadsheetId, params.range, params.values);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_create",
      label: "Google Sheets Create",
      description: "Create a new Google Sheets spreadsheet.",
      parameters: Type.Object({
        title: Type.String({ description: "Title for the new spreadsheet" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsCreate(params.title);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_add_sheet",
      label: "Google Sheets Add Sheet",
      description: "Add a new sheet (tab) to an existing Google Sheets spreadsheet.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        title: Type.String({ description: "Title for the new sheet tab" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsAddSheet(params.spreadsheetId, params.title);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_delete_sheet",
      label: "Google Sheets Delete Sheet",
      description: "Delete a sheet (tab) from a Google Sheets spreadsheet by its numeric sheet ID.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID to delete (from sheets_read or sheets_add_sheet)" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsDeleteSheet(params.spreadsheetId, params.sheetId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_clear",
      label: "Google Sheets Clear",
      description: "Clear all values from a specified range in a Google Sheets spreadsheet without removing formatting.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        range: Type.String({ description: "Cell range to clear, e.g. 'Sheet1!A1:D10'" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsClear(params.spreadsheetId, params.range);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_format_cells",
      label: "Google Sheets Format",
      description: "Format cells in a Google Sheets spreadsheet. Set bold, background color, text color, and font size for a range of cells.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        startRow: Type.Number({ description: "Start row index (0-based)" }),
        endRow: Type.Number({ description: "End row index (exclusive, 0-based)" }),
        startCol: Type.Number({ description: "Start column index (0-based)" }),
        endCol: Type.Number({ description: "End column index (exclusive, 0-based)" }),
        bold: Type.Optional(Type.Boolean({ description: "Whether to bold the text" })),
        bgColor: Type.Optional(Type.Object({ red: Type.Optional(Type.Number()), green: Type.Optional(Type.Number()), blue: Type.Optional(Type.Number()) }, { description: "Background color as RGB values 0-1" })),
        textColor: Type.Optional(Type.Object({ red: Type.Optional(Type.Number()), green: Type.Optional(Type.Number()), blue: Type.Optional(Type.Number()) }, { description: "Text color as RGB values 0-1" })),
        fontSize: Type.Optional(Type.Number({ description: "Font size in points" })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsFormatCells(params.spreadsheetId, params.sheetId, params.startRow, params.endRow, params.startCol, params.endCol, params.bold, params.bgColor, params.textColor, params.fontSize);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_auto_resize",
      label: "Google Sheets Auto Resize",
      description: "Auto-resize columns in a Google Sheets spreadsheet to fit their content.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        startCol: Type.Optional(Type.Number({ description: "Start column index (0-based, optional)" })),
        endCol: Type.Optional(Type.Number({ description: "End column index (exclusive, 0-based, optional)" })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsAutoResize(params.spreadsheetId, params.sheetId, params.startCol, params.endCol);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_merge_cells",
      label: "Google Sheets Merge",
      description: "Merge a range of cells in a Google Sheets spreadsheet.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        startRow: Type.Number({ description: "Start row index (0-based)" }),
        endRow: Type.Number({ description: "End row index (exclusive, 0-based)" }),
        startCol: Type.Number({ description: "Start column index (0-based)" }),
        endCol: Type.Number({ description: "End column index (exclusive, 0-based)" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsMergeCells(params.spreadsheetId, params.sheetId, params.startRow, params.endRow, params.startCol, params.endCol);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_batch_update",
      label: "Google Sheets Batch Update",
      description: "Execute a raw batchUpdate on a Google Sheets spreadsheet. Accepts an array of Sheets API request objects for complex multi-step operations.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        requests: Type.Array(Type.Any(), { description: "Array of Sheets API request objects (e.g. addSheet, mergeCells, updateBorders, etc.)" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsBatchUpdate(params.spreadsheetId, params.requests);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "sheets_sort",
      label: "Google Sheets Sort",
      description: "Sort a sheet by a specific column.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        sortCol: Type.Number({ description: "Column index to sort by (0-based)" }),
        ascending: Type.Optional(Type.Boolean({ description: "Sort ascending (default true). Set false for descending." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.sheetsSort(params.spreadsheetId, params.sheetId, params.sortCol, params.ascending);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildDocsTools(): ToolDefinition[] {
  return [
    {
      name: "docs_list",
      label: "Google Docs List",
      description: "List all Google Docs documents in Drive. Returns most recently modified documents.",
      parameters: Type.Object({}),
      async execute() {
        const result = await gws.docsList();
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_get",
      label: "Google Docs Read",
      description: "Read the full content of a Google Doc by its document ID. Returns the title and extracted text content.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID (from the URL or drive_list)" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsGet(params.documentId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_create",
      label: "Google Docs Create",
      description: "Create a new blank Google Doc with the given title.",
      parameters: Type.Object({
        title: Type.String({ description: "Title for the new document" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsCreate(params.title);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_append",
      label: "Google Docs Append",
      description: "Append text to the end of an existing Google Doc. For rich formatting, this uses plain text insertion.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        text: Type.String({ description: "Text to append to the document" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsAppend(params.documentId, params.text);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_insert_text",
      label: "Google Docs Insert Text",
      description: "Insert text at a specific position in a Google Doc. If no index is provided, inserts at the end of the document.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        text: Type.String({ description: "Text to insert" }),
        index: Type.Optional(Type.Number({ description: "Character index to insert at (1-based). Omit to insert at end." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsInsertText(params.documentId, params.text, params.index);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_delete_content",
      label: "Google Docs Delete Content",
      description: "Delete a range of content from a Google Doc by start and end character index.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        startIndex: Type.Number({ description: "Start character index (1-based, inclusive)" }),
        endIndex: Type.Number({ description: "End character index (exclusive)" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsDeleteContent(params.documentId, params.startIndex, params.endIndex);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_insert_table",
      label: "Google Docs Insert Table",
      description: "Insert an empty table at the end of a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        rows: Type.Number({ description: "Number of rows" }),
        cols: Type.Number({ description: "Number of columns" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsInsertTable(params.documentId, params.rows, params.cols);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_format_text",
      label: "Google Docs Format Text",
      description: "Apply formatting (bold, italic, font size, color) to a range of text in a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        startIndex: Type.Number({ description: "Start character index (1-based, inclusive)" }),
        endIndex: Type.Number({ description: "End character index (exclusive)" }),
        bold: Type.Optional(Type.Boolean({ description: "Set text bold" })),
        italic: Type.Optional(Type.Boolean({ description: "Set text italic" })),
        fontSize: Type.Optional(Type.Number({ description: "Font size in points (e.g. 12, 18, 24)" })),
        foregroundColor: Type.Optional(Type.String({ description: "Text color as hex string (e.g. '#FF0000' for red)" })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsFormatText(params.documentId, params.startIndex, params.endIndex, params.bold, params.italic, params.fontSize, params.foregroundColor);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_insert_image",
      label: "Google Docs Insert Image",
      description: "Insert an inline image into a Google Doc from a URL.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        imageUri: Type.String({ description: "Public URL of the image to insert" }),
        index: Type.Optional(Type.Number({ description: "Character index to insert at. Omit to insert at end." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsInsertImage(params.documentId, params.imageUri, params.index);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_replace_text",
      label: "Google Docs Replace Text",
      description: "Find and replace all occurrences of a text string in a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        findText: Type.String({ description: "Text to find" }),
        replaceText: Type.String({ description: "Replacement text" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsReplaceText(params.documentId, params.findText, params.replaceText);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_insert_heading",
      label: "Google Docs Insert Heading",
      description: "Insert a heading (H1–H6) at the end of a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        text: Type.String({ description: "Heading text" }),
        level: Type.Number({ description: "Heading level 1–6 (1 = largest)" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsInsertHeading(params.documentId, params.text, params.level);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "docs_batch_update",
      label: "Google Docs Batch Update",
      description: "Send a raw batchUpdate request to the Google Docs API. Use for complex multi-step document operations not covered by other tools.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        requests: Type.Array(Type.Any(), { description: "Array of Google Docs API request objects (e.g. insertText, updateTextStyle, etc.)" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.docsBatchUpdate(params.documentId, params.requests);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildSlidesTools(): ToolDefinition[] {
  return [
    {
      name: "slides_list",
      label: "Google Slides List",
      description: "List all Google Slides presentations in Drive. Returns most recently modified presentations.",
      parameters: Type.Object({}),
      async execute() {
        const result = await gws.slidesList();
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_get",
      label: "Google Slides Read",
      description: "Read the content of a Google Slides presentation by ID. Returns slide count, page size, and text content from each slide.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID (from the URL or drive_list)" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesGet(params.presentationId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_create",
      label: "Google Slides Create",
      description: "Create a new blank Google Slides presentation with the given title.",
      parameters: Type.Object({
        title: Type.String({ description: "Title for the new presentation" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesCreate(params.title);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_append",
      label: "Google Slides Add Slide",
      description: "Add a new slide with a title and body text to an existing Google Slides presentation. The slide uses a Title and Body layout.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID (from the URL or drive_list)" }),
        title: Type.String({ description: "Title text for the new slide" }),
        body: Type.String({ description: "Body text content for the new slide" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesAppend(params.presentationId, params.title, params.body);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_insert_table",
      label: "Google Slides Insert Table",
      description: "Insert a table on a slide. Optionally populate cells with data.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The slide object ID to insert the table on" }),
        rows: Type.Number({ description: "Number of rows" }),
        cols: Type.Number({ description: "Number of columns" }),
        data: Type.Optional(Type.Array(Type.Array(Type.String()), { description: "2D array of cell values, e.g. [[\"Header1\",\"Header2\"],[\"A\",\"B\"]]" })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesInsertTable(params.presentationId, params.slideObjectId, params.rows, params.cols, params.data);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_insert_image",
      label: "Google Slides Insert Image",
      description: "Insert an image on a slide from a public URL.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The slide object ID to insert the image on" }),
        imageUrl: Type.String({ description: "Public URL of the image to insert" }),
        width: Type.Optional(Type.Number({ description: "Image width in EMU (default 3000000). 914400 EMU = 1 inch." })),
        height: Type.Optional(Type.Number({ description: "Image height in EMU (default 3000000)" })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesInsertImage(params.presentationId, params.slideObjectId, params.imageUrl, params.width, params.height);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_insert_shape",
      label: "Google Slides Insert Shape",
      description: "Insert a shape (rectangle, ellipse, etc.) with optional text on a slide. Positions and sizes are in EMU (914400 EMU = 1 inch).",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The slide object ID" }),
        shapeType: Type.String({ description: "Shape type: TEXT_BOX, RECTANGLE, ROUND_RECTANGLE, ELLIPSE, TRIANGLE, ARROW_NORTH, ARROW_EAST, STAR_5, etc." }),
        text: Type.Optional(Type.String({ description: "Text to insert inside the shape" })),
        left: Type.Number({ description: "Left position in EMU" }),
        top: Type.Number({ description: "Top position in EMU" }),
        width: Type.Number({ description: "Shape width in EMU" }),
        height: Type.Number({ description: "Shape height in EMU" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesInsertShape(params.presentationId, params.slideObjectId, params.shapeType, params.text, params.left, params.top, params.width, params.height);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_format_text",
      label: "Google Slides Format Text",
      description: "Format text within a shape or text box on a slide. Specify character range and styling options.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        objectId: Type.String({ description: "The shape/text box object ID containing the text" }),
        startIndex: Type.Number({ description: "Start character index (0-based)" }),
        endIndex: Type.Number({ description: "End character index (exclusive)" }),
        bold: Type.Optional(Type.Boolean({ description: "Set bold" })),
        italic: Type.Optional(Type.Boolean({ description: "Set italic" })),
        fontSize: Type.Optional(Type.Number({ description: "Font size in points" })),
        color: Type.Optional(Type.String({ description: "Text color as hex string, e.g. '#FF0000'" })),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesFormatText(params.presentationId, params.objectId, params.startIndex, params.endIndex, params.bold, params.italic, params.fontSize, params.color);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_delete_slide",
      label: "Google Slides Delete Slide",
      description: "Delete a slide from a presentation by its slide object ID.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The object ID of the slide to delete" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesDeleteSlide(params.presentationId, params.slideObjectId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_duplicate_slide",
      label: "Google Slides Duplicate Slide",
      description: "Duplicate an existing slide in a presentation. Returns the new slide's object ID.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The object ID of the slide to duplicate" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesDuplicateSlide(params.presentationId, params.slideObjectId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_replace_text",
      label: "Google Slides Replace Text",
      description: "Find and replace text across all slides in a presentation.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        findText: Type.String({ description: "Text to find" }),
        replaceText: Type.String({ description: "Replacement text" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesReplaceText(params.presentationId, params.findText, params.replaceText);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "slides_batch_update",
      label: "Google Slides Batch Update",
      description: "Execute raw batch update requests against the Google Slides API. For complex multi-step operations not covered by other slides tools. See Google Slides API batchUpdate documentation for request format.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        requests: Type.Array(Type.Any(), { description: "Array of Slides API request objects" }),
      }),
      async execute(_toolCallId, params) {
        const result = await gws.slidesBatchUpdate(params.presentationId, params.requests);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildYouTubeTools(): ToolDefinition[] {
  return [
    {
      name: "youtube_search",
      label: "YouTube Search",
      description: "Search for YouTube videos by keyword. Returns video titles, channels, publish dates, and URLs.",
      parameters: Type.Object({
        query: Type.String({ description: "Search keywords (e.g. 'TypeScript tutorial', 'SpaceX launch')" }),
        maxResults: Type.Optional(Type.Number({ description: "Max videos to return (default 10, max 25)" })),
      }),
      async execute(_toolCallId, params) {
        const result = await youtube.youtubeSearch(params.query, params.maxResults || 10);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "youtube_video",
      label: "YouTube Video Details",
      description: "Get detailed information about a YouTube video — title, channel, views, likes, comments, duration, and description. Requires the video ID (the part after v= in the URL).",
      parameters: Type.Object({
        videoId: Type.String({ description: "YouTube video ID (e.g. 'dQw4w9WgXcQ' from youtube.com/watch?v=dQw4w9WgXcQ)" }),
      }),
      async execute(_toolCallId, params) {
        const result = await youtube.youtubeVideoDetails(params.videoId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "youtube_channel",
      label: "YouTube Channel Info",
      description: "Get information about a YouTube channel — name, subscriber count, video count, total views, and description. Accepts a channel ID (starts with UC) or channel name to search for.",
      parameters: Type.Object({
        channel: Type.String({ description: "Channel ID (e.g. 'UCBcRF18a7Qf58cCRy5xuWwQ') or channel name to search for (e.g. 'MKBHD')" }),
      }),
      async execute(_toolCallId, params) {
        const result = await youtube.youtubeChannelInfo(params.channel);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "youtube_trending",
      label: "YouTube Trending",
      description: "Get currently trending/popular videos on YouTube. Optionally specify a country code.",
      parameters: Type.Object({
        regionCode: Type.Optional(Type.String({ description: "ISO 3166-1 alpha-2 country code (default 'US', e.g. 'GB', 'IN', 'JP')" })),
        maxResults: Type.Optional(Type.Number({ description: "Max videos to return (default 10, max 25)" })),
      }),
      async execute(_toolCallId, params) {
        const result = await youtube.youtubeTrending(params.regionCode || "US", params.maxResults || 10);
        return { content: [{ type: "text" as const, text: result }], details: {} };
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
        const results = await conversations.search(params.query, { after, limit: 8 });

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

function buildAgentTools(allToolsFn: () => ToolDefinition[]): ToolDefinition[] {
  return [
    {
      name: "delegate",
      label: "Delegate to Agent",
      description:
        "Delegate a complex task to a specialist agent. The agent will work independently using its own tools and return a comprehensive result. Use this for multi-step research, project planning, deep analysis, email drafting, or vault organization.",
      parameters: Type.Object({
        agent: Type.String({ description: "The specialist agent ID (e.g. 'deep-researcher', 'project-planner', 'analyst', 'email-drafter', 'knowledge-organizer')" }),
        task: Type.String({ description: "Clear description of what the agent should do" }),
        context: Type.Optional(Type.String({ description: "Additional context the agent needs (e.g. previous conversation details, specific requirements)" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await runSubAgent({
            agentId: params.agent,
            task: params.task,
            context: params.context,
            allTools: allToolsFn() as any,
            apiKey: ANTHROPIC_KEY,
          });
          return {
            content: [{ type: "text" as const, text: result.response }],
            details: { agent: result.agentId, toolsUsed: result.toolsUsed, durationMs: result.durationMs },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Agent delegation failed: ${err.message}` }],
            details: { error: true },
          };
        }
      },
    },
    {
      name: "list_agents",
      label: "List Agents",
      description: "List all available specialist agents with their names and descriptions. Use when the user asks what agents are available or what your team can do.",
      parameters: Type.Object({}),
      async execute() {
        const agents = agentLoader.getEnabledAgents();
        if (agents.length === 0) {
          return { content: [{ type: "text" as const, text: "No specialist agents are currently configured." }], details: {} };
        }
        const list = agents.map(a => `- **${a.name}** (${a.id}): ${a.description}`).join("\n");
        return {
          content: [{ type: "text" as const, text: `Available specialist agents:\n\n${list}` }],
          details: { count: agents.length },
        };
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

interface PendingMessage {
  text: string;
  images?: Array<{ mimeType: string; data: string }>;
  timestamp: number;
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
  isAgentRunning: boolean;
  pendingMessages: PendingMessage[];
  startupContext?: string;
}
const sessions = new Map<string, SessionEntry>();

const FAST_MODEL_ID = "claude-haiku-4-5-20251001";
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

async function saveAndCleanSession(id: string) {
  const entry = sessions.get(id);
  if (!entry) return;
  if (entry.currentAgentText) {
    conversations.addMessage(entry.conversation, "agent", entry.currentAgentText);
    entry.currentAgentText = "";
  }
  if (entry.conversation.messages.length > 0) {
    await conversations.save(entry.conversation);
    syncConversationToVault(entry.conversation);
  }
  for (const sub of entry.subscribers) { try { sub.end(); } catch {} }
  entry.subscribers.clear();
  sessions.delete(id);
}

async function syncConversationToVault(conv: conversations.Conversation) {
  if (syncedConversations.has(conv.id)) return;
  if (!conversations.shouldSync(conv)) return;
  if (!useLocalVault && !obsidian.isConfigured()) return;

  const existing = await conversations.load(conv.id);
  if (existing && (existing as any).syncedAt) {
    syncedConversations.add(conv.id);
    return;
  }

  const userMsgCount = conv.messages.filter(m => m.role === "user").length;
  const useAI = userMsgCount >= 3;

  try {
    const summary = useAI
      ? await conversations.generateAISummary(conv)
      : conversations.generateSnippetSummary(conv);
    const dateStr = new Date(conv.createdAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    let safeTitle = conv.title.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 50).trim();
    if (!safeTitle) safeTitle = conv.id;
    const notePath = `Conversations/${dateStr} - ${safeTitle}.md`;
    await kbCreate(notePath, summary);
    syncedConversations.add(conv.id);
    (conv as any).syncedAt = Date.now();
    await conversations.save(conv);
    console.log(`[sync] Conversation synced to vault: ${notePath} (${useAI ? "AI" : "snippet"} summary)`);

    if (useAI) {
      runInsightExtraction(conv).catch(err =>
        console.error(`[sync] Insight extraction failed for ${conv.id}:`, err)
      );
    }
  } catch (err) {
    console.error(`[sync] Failed to sync conversation ${conv.id}:`, err);
  }
}

async function runInsightExtraction(conv: conversations.Conversation) {
  try {
    let currentProfile = "";
    try {
      currentProfile = await kbRead("About Me/My Profile.md");
    } catch {}

    const result = await extractAndFileInsights(conv.messages, currentProfile);

    if (result.skipReason) {
      console.log(`[memory] Skipped extraction for ${conv.id}: ${result.skipReason}`);
      return;
    }

    if (result.profileUpdates.length > 0) {
      const newEntries = result.profileUpdates.map(u => `- ${u}`).join("\n");
      const appendText = `\n\n### Learned (${new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })})\n${newEntries}`;
      try {
        await kbAppend("About Me/My Profile.md", appendText);
        console.log(`[memory] Appended ${result.profileUpdates.length} profile updates`);
      } catch {
        await kbCreate("About Me/My Profile.md", currentProfile + appendText);
        console.log(`[memory] Created/overwrote profile with ${result.profileUpdates.length} updates`);
      }
    }

    if (result.actionItems.length > 0) {
      const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const items = result.actionItems.map(a => `- [ ] ${a}`).join("\n");
      const appendText = `\n\n### From conversation (${dateStr}): ${conv.title}\n${items}`;
      try {
        await kbAppend("Tasks & TODOs/Extracted Tasks.md", appendText);
      } catch {
        await kbCreate("Tasks & TODOs/Extracted Tasks.md", `# Extracted Tasks\n${appendText}`);
      }
      console.log(`[memory] Filed ${result.actionItems.length} action items`);
    }
  } catch (err) {
    console.error(`[memory] Insight extraction error:`, err);
  }
}

let processingQueue = new Set<string>();

async function processNextPendingMessage(sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry || entry.pendingMessages.length === 0) return;
  if (processingQueue.has(sessionId) || entry.isAgentRunning) return;
  
  processingQueue.add(sessionId);
  const pending = entry.pendingMessages.shift()!;
  entry.isAgentRunning = true;
  entry.currentAgentText = "";

  const startEvent = JSON.stringify({ type: "agent_start" });
  for (const sub of entry.subscribers) {
    try { sub.write(`data: ${startEvent}\n\n`); } catch {}
  }

  const queuedPromptStart = Date.now();
  const etNow = new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  const queueContext = "[Note: This message was sent while the previous task was still running. The previous task has now completed.]\n\n";
  const augmentedText = `[Current date/time in Rickin's timezone (Eastern): ${etNow}]\n\n${queueContext}${pending.text}`;
  const promptImages = pending.images?.map(i => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));

  const PROMPT_TIMEOUT = 900_000;
  const actualPromise = entry.session.prompt(augmentedText, promptImages ? { images: promptImages } : undefined);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Response timed out after 15 minutes")), PROMPT_TIMEOUT)
  );

  try {
    await Promise.race([actualPromise, timeoutPromise]);
    console.log(`[prompt] queued prompt completed in ${((Date.now() - queuedPromptStart) / 1000).toFixed(1)}s`);
  } catch (err) {
    const elapsed = ((Date.now() - queuedPromptStart) / 1000).toFixed(1);
    const isTimeout = String(err).includes("timed out");
    console.error(`[prompt] queued ${isTimeout ? "timeout" : "error"} after ${elapsed}s:`, err);
    const errEvent = JSON.stringify({ type: isTimeout ? "timeout" : "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try { sub.write(`data: ${errEvent}\n\n`); } catch {}
    }
    if (isTimeout) {
      console.log(`[prompt] queued agent still running in background — new messages will be queued`);
      actualPromise.then(() => {
        console.log(`[prompt] queued background prompt completed after ${((Date.now() - queuedPromptStart) / 1000).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        processingQueue.delete(sessionId);
        processNextPendingMessage(sessionId);
      }).catch(() => {
        console.log(`[prompt] queued background prompt failed after ${((Date.now() - queuedPromptStart) / 1000).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        processingQueue.delete(sessionId);
        processNextPendingMessage(sessionId);
      });
      return;
    }
    entry.isAgentRunning = false;
    processingQueue.delete(sessionId);
    processNextPendingMessage(sessionId);
    return;
  }
  processingQueue.delete(sessionId);
}

setInterval(async () => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of sessions.entries()) {
    if (entry.createdAt < cutoff) {
      await saveAndCleanSession(id);
    }
  }
}, 10 * 60 * 1000);

setInterval(async () => {
  for (const entry of sessions.values()) {
    if (entry.currentAgentText) {
      conversations.addMessage(entry.conversation, "agent", entry.currentAgentText);
      entry.currentAgentText = "";
    }
    if (entry.conversation.messages.length > 0) {
      await conversations.save(entry.conversation);
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
  if (envUrl) {
    obsidian.setApiUrl(envUrl);
    if (!useLocalVault) console.log(`[boot] Using tunnel URL from env: ${envUrl}`);
  } else {
    const savedUrl = loadPersistedTunnelUrl();
    if (savedUrl) {
      obsidian.setApiUrl(savedUrl);
      if (!useLocalVault) console.log(`[boot] Loaded persisted tunnel URL: ${savedUrl}`);
    }
  }
})();

let lastTunnelStatus = useLocalVault;
if (!useLocalVault && obsidian.isConfigured()) {
  setInterval(async () => {
    if (useLocalVault) return;
    const alive = await obsidian.ping();
    if (alive && !lastTunnelStatus) {
      console.log("[health] Knowledge base connection recovered");
    } else if (!alive && lastTunnelStatus) {
      console.warn("[health] Knowledge base connection DOWN — check that Obsidian is running and tunnel service is active");
    }
    lastTunnelStatus = alive;
  }, 30 * 1000);

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

  const devToken = process.env.DEV_TOKEN;
  if (devToken && req.query.dev_token === devToken) {
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.cookie("auth", "authenticated", { signed: true, httpOnly: true, secure: isSecure, maxAge: 7 * 24 * 60 * 60 * 1000 });
    next();
    return;
  }

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

const cachedStaticTools: ToolDefinition[] = [
  ...buildGmailTools(),
  ...buildCalendarTools(),
  ...buildWeatherTools(),
  ...buildSearchTools(),
  ...buildTaskTools(),
  ...buildNewsTools(),
  ...buildTwitterTools(),
  ...buildStockTools(),
  ...buildMapsTools(),
  ...buildDriveTools(),
  ...buildSheetsTools(),
  ...buildDocsTools(),
  ...buildSlidesTools(),
  ...buildYouTubeTools(),
  ...buildConversationTools(),
];

app.post("/api/session", async (req: Request, res: Response) => {
  try {
    const { resumeConversationId } = req.body as { resumeConversationId?: string } || {};
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const authStorage = AuthStorage.create(path.join(AGENT_DIR, "auth.json"));
    authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);

    const modelRegistry = new ModelRegistry(authStorage, path.join(AGENT_DIR, "models.json"));
    const fullModel = modelRegistry.find("anthropic", FULL_MODEL_ID);
    if (!fullModel) throw new Error(`Model ${FULL_MODEL_ID} not found in registry`);

    const coreTools = [
      ...buildKnowledgeBaseTools(),
      ...cachedStaticTools,
      ...buildInterviewTool(sessionId),
    ];
    const allTools = [
      ...coreTools,
      ...buildAgentTools(() => coreTools),
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
    let resumedMessages: any[] = [];

    if (resumeConversationId) {
      const oldConv = await conversations.load(resumeConversationId);
      if (oldConv && oldConv.messages.length > 0) {
        for (const msg of oldConv.messages) {
          conversations.addMessage(conv, msg.role, msg.text);
        }
        resumedMessages = oldConv.messages;
        conv.title = oldConv.title;
        console.log(`[session] Resuming conversation "${oldConv.title}" with ${oldConv.messages.length} messages`);
        await conversations.remove(resumeConversationId);
      }
    }

    const entry: SessionEntry = {
      session,
      subscribers: new Set(),
      createdAt: Date.now(),
      conversation: conv,
      currentAgentText: "",
      modelMode: "auto",
      activeModelName: FULL_MODEL_ID,
      isAgentRunning: false,
      pendingMessages: [],
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
        entry.isAgentRunning = false;
        if (entry.currentAgentText) {
          conversations.addMessage(entry.conversation, "agent", entry.currentAgentText);
          entry.currentAgentText = "";
        }
        conversations.save(entry.conversation).catch(err => console.error("[conversations] save error:", err));
        syncConversationToVault(entry.conversation);

        const nonSystem = entry.conversation.messages.filter(m => m.role !== "system");
        if (nonSystem.length >= 2 && nonSystem.length <= 4) {
          conversations.generateTitle(entry.conversation).then(title => {
            if (title) {
              conversations.save(entry.conversation).catch(err => console.error("[conversations] title save error:", err));
            }
          }).catch(err => console.warn("[conversations] title generation error:", err));
        }

        processNextPendingMessage(sessionId);
      }
    });

    let combinedContext: string | null;
    if (resumeConversationId && resumedMessages.length > 0) {
      const last10 = resumedMessages.slice(-10);
      const resumeContext = `[RESUMED CONVERSATION: "${conv.title}"]\nThe user is resuming a previous conversation. Here are the last ${last10.length} messages for context:\n\n` +
        last10.map(m => `${m.role.toUpperCase()}: ${m.text}`).join("\n\n");
      const vaultIndex = await getVaultIndex();
      combinedContext = [resumeContext, vaultIndex].filter(Boolean).join("\n\n---\n\n");
    } else {
      const recentSummary = await conversations.getRecentSummary(5);
      const lastConvoContext = await conversations.getLastConversationContext(10);
      const vaultIndex = await getVaultIndex();
      combinedContext = [lastConvoContext, recentSummary, vaultIndex].filter(Boolean).join("\n\n---\n\n") || null;
    }
    entry.startupContext = combinedContext || undefined;

    res.json({ sessionId, recentContext: combinedContext, messages: resumedMessages });
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

app.get("/api/session/:id/status", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.json({ alive: false }); return; }
  res.json({
    alive: true,
    agentRunning: entry.isAgentRunning,
    currentAgentText: entry.currentAgentText,
    messages: entry.conversation.messages,
    pendingCount: entry.pendingMessages.length,
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
  await conversations.save(entry.conversation);

  if (entry.isAgentRunning) {
    entry.pendingMessages.push({ text, images, timestamp: Date.now() });
    const queuedEvent = JSON.stringify({ type: "message_queued", position: entry.pendingMessages.length });
    for (const sub of entry.subscribers) {
      try { sub.write(`data: ${queuedEvent}\n\n`); } catch {}
    }
    res.json({ ok: true, queued: true, position: entry.pendingMessages.length });
    return;
  }

  let chosenModelId = FULL_MODEL_ID;
  const hasImages = images && images.length > 0;
  if (hasImages) {
    chosenModelId = FULL_MODEL_ID;
  } else if (entry.modelMode === "fast") {
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

  entry.isAgentRunning = true;
  entry.currentAgentText = "";

  const startEvent = JSON.stringify({ type: "agent_start" });
  for (const sub of entry.subscribers) {
    try { sub.write(`data: ${startEvent}\n\n`); } catch {}
  }

  if (hasImages) {
    const totalB64 = images!.reduce((sum, i) => sum + i.data.length, 0);
    const mimeTypes = images!.map(i => i.mimeType).join(", ");
    console.log(`[prompt] ${images!.length} image(s), ~${Math.round(totalB64 / 1024)}KB base64, types: ${mimeTypes}`);
  }

  const promptStart = Date.now();
  const sessionId = req.params["id"] as string;
  const etNow = new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  let augmentedText = `[Current date/time in Rickin's timezone (Eastern): ${etNow}]\n\n`;
  if (entry.startupContext) {
    augmentedText += `[Session Context]\n${entry.startupContext}\n\n`;
    entry.startupContext = undefined;
  }
  augmentedText += text;
  const promptImages = images?.map(i => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));

  const PROMPT_TIMEOUT = 900_000;
  const actualPromise = entry.session.prompt(augmentedText, promptImages ? { images: promptImages } : undefined);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Response timed out after 15 minutes")), PROMPT_TIMEOUT)
  );

  try {
    await Promise.race([actualPromise, timeoutPromise]);
    console.log(`[prompt] completed in ${((Date.now() - promptStart) / 1000).toFixed(1)}s`);
    entry.isAgentRunning = false;
    processNextPendingMessage(sessionId);
  } catch (err) {
    const elapsed = ((Date.now() - promptStart) / 1000).toFixed(1);
    const isTimeout = String(err).includes("timed out");
    console.error(`[prompt] ${isTimeout ? "timeout" : "error"} after ${elapsed}s:`, err);
    const errEvent = JSON.stringify({ type: isTimeout ? "timeout" : "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try { sub.write(`data: ${errEvent}\n\n`); } catch {}
    }
    if (isTimeout) {
      console.log(`[prompt] agent still running in background — new messages will be queued`);
      actualPromise.then(() => {
        console.log(`[prompt] background prompt finally completed after ${((Date.now() - promptStart) / 1000).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        processNextPendingMessage(sessionId);
      }).catch(() => {
        console.log(`[prompt] background prompt failed after ${((Date.now() - promptStart) / 1000).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        processNextPendingMessage(sessionId);
      });
    } else {
      entry.isAgentRunning = false;
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

app.delete("/api/session/:id", async (req: Request, res: Response) => {
  await saveAndCleanSession(req.params["id"] as string);
  res.json({ ok: true });
});

app.get("/api/conversations/search", async (req: Request, res: Response) => {
  const q = (req.query["q"] as string) || "";
  if (!q.trim()) { res.json([]); return; }
  const before = req.query["before"] ? Number(req.query["before"]) : undefined;
  const after = req.query["after"] ? Number(req.query["after"]) : undefined;
  const results = await conversations.search(q, { before, after });
  res.json(results);
});

app.get("/api/conversations", async (_req: Request, res: Response) => {
  res.json(await conversations.list());
});

app.get("/api/conversations/:id", async (req: Request, res: Response) => {
  const conv = await conversations.load(req.params["id"] as string);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  res.json(conv);
});

app.delete("/api/conversations/:id", async (req: Request, res: Response) => {
  await conversations.remove(req.params["id"] as string);
  res.json({ ok: true });
});


app.get("/api/tasks", async (_req: Request, res: Response) => {
  try {
    const active = await tasks.getActiveTasks();
    res.json(active);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/tasks", async (req: Request, res: Response) => {
  try {
    const { title, priority, dueDate } = req.body as { title?: string; priority?: string; dueDate?: string };
    if (!title || !title.trim()) { res.status(400).json({ error: "title required" }); return; }
    await tasks.addTask(title.trim(), { priority: priority as any, dueDate });
    glanceCache = null;
    const active = await tasks.getActiveTasks();
    const created = active.find(t => t.title === title.trim());
    res.json({ ok: true, task: created || { title: title.trim(), priority: priority || "medium", dueDate } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.patch("/api/tasks/:id/complete", async (req: Request, res: Response) => {
  try {
    const result = await tasks.completeTask(req.params["id"] as string);
    glanceCache = null;
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete("/api/tasks/:id", async (req: Request, res: Response) => {
  try {
    const result = await tasks.deleteTask(req.params["id"] as string);
    glanceCache = null;
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
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
          const unread = await gmail.getUnreadCount();
          result.emails = { unread };
        } catch {}
      })());
    }

    promises.push((async () => {
      try {
        const active = await tasks.getActiveTasks();
        result.tasks = { active: active.length, items: active };
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
  res.json({ online: useLocalVault || lastTunnelStatus, mode: useLocalVault ? "local" : "remote" });
});

let obSyncProcess: ChildProcess | null = null;

function startObSync() {
  const vaultPath = path.join(process.cwd(), "data", "vault");
  const logPath = "/tmp/obsidian-sync.log";

  if (obSyncProcess) {
    try { obSyncProcess.kill(); } catch {}
    obSyncProcess = null;
  }

  try {
    execSync("pgrep -f 'ob sync' 2>/dev/null && pkill -f 'ob sync'", { encoding: "utf-8" });
  } catch {}

  const logFd = fs.openSync(logPath, "a");
  const child = spawn("ob", ["sync", "--continuous", "--path", vaultPath], {
    stdio: ["ignore", logFd, logFd],
    detached: false,
  });

  child.on("error", (err) => {
    console.error("[sync] ob sync failed to start:", err.message);
    obSyncProcess = null;
  });

  child.on("exit", (code) => {
    console.warn(`[sync] ob sync exited with code ${code} — restarting in 10s`);
    obSyncProcess = null;
    setTimeout(() => {
      if (!obSyncProcess) startObSync();
    }, 10_000);
  });

  obSyncProcess = child;
  console.log(`[sync] ob sync started (pid ${child.pid})`);
}

function getSyncStatus(): { running: boolean; status: string; lastLine: string; lastChecked: string } {
  const logPath = "/tmp/obsidian-sync.log";
  const lastChecked = new Date().toISOString();
  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(l => l.trim());
    if (lines.length === 0) return { running: false, status: "not_running", lastLine: "", lastChecked };
    const lastLine = lines[lines.length - 1].trim();
    let running = true;
    let status = "unknown";
    if (/fully synced/i.test(lastLine)) status = "synced";
    else if (/upload complete/i.test(lastLine)) status = "synced";
    else if (/uploading/i.test(lastLine)) status = "uploading";
    else if (/download complete/i.test(lastLine)) status = "synced";
    else if (/downloading/i.test(lastLine)) status = "downloading";
    else if (/connection successful/i.test(lastLine)) status = "connected";
    else if (/connecting/i.test(lastLine)) status = "connecting";
    else if (/error|failed|disconnect/i.test(lastLine)) { status = "error"; running = false; }
    try {
      const { execSync } = require("child_process");
      const ps = execSync("pgrep -f 'ob sync' 2>/dev/null", { encoding: "utf-8" }).trim();
      running = ps.length > 0;
    } catch { running = false; }
    return { running, status, lastLine, lastChecked };
  } catch {
    return { running: false, status: "not_running", lastLine: "no log file", lastChecked };
  }
}

app.get("/api/sync-status", (_req, res) => {
  res.json(getSyncStatus());
});

let lastSyncLogStatus = "";
setInterval(() => {
  const sync = getSyncStatus();
  const key = `${sync.running}:${sync.status}`;
  if (key !== lastSyncLogStatus) {
    const icon = sync.running ? "●" : "○";
    console.log(`[sync] ${icon} ob sync ${sync.running ? "running" : "stopped"} — ${sync.status}${sync.status === "error" ? ": " + sync.lastLine : ""}`);
    lastSyncLogStatus = key;
  }
}, 60_000);

app.get("/api/agents", (_req, res) => {
  const agents = agentLoader.getAgents().map(a => ({
    id: a.id,
    name: a.name,
    description: a.description,
    enabled: a.enabled,
    tools: a.tools,
    timeout: a.timeout,
    model: a.model,
  }));
  res.json({ agents });
});

interface TreeEntry { name: string; type: "file" | "folder"; children?: TreeEntry[] }

async function buildVaultTree(dir: string): Promise<TreeEntry[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const result: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const children = await buildVaultTree(path.join(dir, entry.name));
      result.push({ name: entry.name, type: "folder", children });
    } else {
      result.push({ name: entry.name, type: "file" });
    }
  }
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function formatVaultIndex(entries: TreeEntry[], indent: number = 0): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const prefix = "  ".repeat(indent);
    if (entry.type === "folder") {
      lines.push(`${prefix}${entry.name}/`);
      if (entry.children) {
        lines.push(formatVaultIndex(entry.children, indent + 1));
      }
    } else {
      lines.push(`${prefix}${entry.name}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

async function getVaultIndex(): Promise<string> {
  try {
    const tree = await buildVaultTree(VAULT_DIR);
    return `## Vault Index (all folders and files)\n${formatVaultIndex(tree)}`;
  } catch {
    return "";
  }
}

app.get("/api/vault-tree", async (_req, res) => {
  try {
    const tree = await buildVaultTree(VAULT_DIR);
    res.json({ vault: tree });
  } catch (err) {
    res.status(500).json({ error: "Failed to read vault structure" });
  }
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
  if (obSyncProcess) {
    try { obSyncProcess.kill(); } catch {}
    obSyncProcess = null;
  }
  for (const [id] of sessions.entries()) {
    saveAndCleanSession(id);
  }
  server.close(() => { process.exit(0); });
  setTimeout(() => { process.exit(1); }, 3000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

function killPort(port: number) {
  try {
    execSync(`fuser -k -9 ${port}/tcp`, { stdio: "ignore" });
  } catch {}
  try {
    execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: "ignore" });
  } catch {}
}

function isPortInUse(port: number): boolean {
  try {
    const out = execSync(`fuser ${port}/tcp 2>/dev/null`, { encoding: "utf-8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

async function waitForPort(port: number, maxWaitMs = 30000) {
  const start = Date.now();
  let attempt = 0;
  killPort(port);
  await new Promise(r => setTimeout(r, 500));
  while (Date.now() - start < maxWaitMs) {
    if (!isPortInUse(port)) return true;
    attempt++;
    console.warn(`[boot] Port ${port} still in use — waiting... (attempt ${attempt})`);
    killPort(port);
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function startServer(maxRetries = 5) {
  await db.init();
  await conversations.init();
  await gmail.init();
  await tasks.init();
  await alerts.init();
  console.log("[boot] PostgreSQL ready (shared pool, 4 tables)");

  gmail.checkConnectionStatus().then(status => {
    if (status.connected) console.log(`[boot] Google connected: ${status.email} (Gmail, Calendar, Drive, Sheets)`);
    else console.warn(`[boot] Google not connected: ${status.error}`);
  }).catch(() => {});

  const portReady = await waitForPort(PORT);
  if (!portReady) {
    console.error(`[boot] Port ${PORT} could not be freed after 30s — exiting`);
    process.exit(1);
  }

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

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server = createServer(app);
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && attempt < maxRetries) {
            console.warn(`[boot] EADDRINUSE on attempt ${attempt}/${maxRetries} — retrying in 3s...`);
            server.close();
            reject(err);
          } else {
            console.error(`[boot] Fatal server error:`, err);
            process.exit(1);
          }
        });
        server.listen(PORT, "0.0.0.0", () => {
          console.log(`[ready] pi-replit listening on http://localhost:${PORT}`);
          startObSync();
          alerts.startAlertSystem(broadcastToAll, async (briefPath, content) => {
            try { await kbCreate(briefPath, content); } catch (err) {
              console.error(`[alerts] Vault save failed for ${briefPath}:`, err);
            }
          });
          resolve();
        });
      });
      return;
    } catch {
      killPort(PORT);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.error(`[boot] Could not bind port ${PORT} after ${maxRetries} attempts — exiting`);
  process.exit(1);
}

startServer();
