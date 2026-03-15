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
import * as webfetch from "./src/webfetch.js";
import * as tasks from "./src/tasks.js";
import * as news from "./src/news.js";
import * as twitter from "./src/twitter.js";
import * as stocks from "./src/stocks.js";
import * as maps from "./src/maps.js";
import * as gws from "./src/gws.js";
import * as youtube from "./src/youtube.js";
import * as alerts from "./src/alerts.js";
import * as scheduledJobs from "./src/scheduled-jobs.js";
import * as agentLoader from "./src/agents/loader.js";
import { runSubAgent } from "./src/agents/orchestrator.js";
import { extractAndFileInsights } from "./src/memory-extractor.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const POOJA_PASSWORD = process.env.POOJA_PASSWORD || "";
const DARKNODE_PASSWORD = process.env.DARKNODE_PASSWORD || "";
const USERS: Record<string, { password: string; displayName: string }> = {
  rickin: { password: APP_PASSWORD, displayName: "Rickin" },
  pooja: { password: POOJA_PASSWORD, displayName: "Pooja" },
  darknode: { password: DARKNODE_PASSWORD, displayName: "DarkNode" },
};
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
    {
      name: "email_get_attachment",
      label: "Email Attachment",
      description: "Download and read an email attachment. For PDFs, extracts text content automatically. Specify the email message ID and optionally a filename to target a specific attachment. Use email_read first to see what attachments exist.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID containing the attachment." }),
        attachmentId: Type.Optional(Type.String({ description: "Specific attachment ID (from email_read). If omitted, reads the first attachment." })),
        filename: Type.Optional(Type.String({ description: "Partial filename to match (e.g. 'invoice' to find 'invoice.pdf'). Used if attachmentId not provided." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.getAttachment(params.messageId, params.attachmentId, params.filename);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_send",
      label: "Send Email",
      description: "Send a new email. IMPORTANT: Always confirm with the user via interview form BEFORE calling this tool — show them the recipient, subject, and full body for review. Never auto-send.",
      parameters: Type.Object({
        to: Type.String({ description: "Recipient email address(es), comma-separated for multiple." }),
        subject: Type.String({ description: "Email subject line." }),
        body: Type.String({ description: "Email body text (plain text)." }),
        cc: Type.Optional(Type.String({ description: "CC recipients, comma-separated." })),
        bcc: Type.Optional(Type.String({ description: "BCC recipients, comma-separated." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.sendEmail(params.to, params.subject, params.body, params.cc, params.bcc);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_reply",
      label: "Reply to Email",
      description: "Reply to an existing email in-thread with proper threading headers. IMPORTANT: Always confirm with the user via interview form BEFORE calling this tool — show them the reply body for review. Never auto-send.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to reply to." }),
        body: Type.String({ description: "Reply body text (plain text)." }),
        replyAll: Type.Optional(Type.Boolean({ description: "If true, reply to all recipients. Default: false (reply to sender only)." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.replyToEmail(params.messageId, params.body, params.replyAll ?? false);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_thread",
      label: "Email Thread",
      description: "Read an entire email conversation thread. Returns all messages in order. Get the threadId from email_list or email_read results.",
      parameters: Type.Object({
        threadId: Type.String({ description: "The Gmail thread ID." }),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.getThread(params.threadId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_draft",
      label: "Save Email Draft",
      description: "Save a composed email as a Gmail draft without sending it. The draft will appear in Gmail's Drafts folder for later review and sending.",
      parameters: Type.Object({
        to: Type.String({ description: "Recipient email address(es)." }),
        subject: Type.String({ description: "Email subject line." }),
        body: Type.String({ description: "Email body text (plain text)." }),
        cc: Type.Optional(Type.String({ description: "CC recipients, comma-separated." })),
        bcc: Type.Optional(Type.String({ description: "BCC recipients, comma-separated." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.createDraft(params.to, params.subject, params.body, params.cc, params.bcc);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_archive",
      label: "Archive Email",
      description: "Archive an email (remove from inbox without deleting). The email remains searchable and in All Mail.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to archive." }),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.archiveEmail(params.messageId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_label",
      label: "Email Labels",
      description: "Add or remove Gmail labels on an email. Use system label IDs (STARRED, IMPORTANT, UNREAD, SPAM, TRASH, CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_FORUMS) or custom label IDs from gmail_list_labels.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID." }),
        addLabels: Type.Optional(Type.Array(Type.String(), { description: "Label IDs to add." })),
        removeLabels: Type.Optional(Type.Array(Type.String(), { description: "Label IDs to remove." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.modifyLabels(params.messageId, params.addLabels, params.removeLabels);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_mark_read",
      label: "Mark Email Read/Unread",
      description: "Mark an email as read or unread.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID." }),
        read: Type.Boolean({ description: "true to mark as read, false to mark as unread." }),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.markRead(params.messageId, params.read);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_trash",
      label: "Trash Email",
      description: "Move an email to the trash. It can be recovered from Trash within 30 days.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to trash." }),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.trashEmail(params.messageId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "gmail_list_labels",
      label: "List Gmail Labels",
      description: "List all Gmail labels (system and custom). Returns label names and IDs. Use before email_label to find the correct label ID, or before gmail_delete_label to find the ID of a label to remove.",
      parameters: Type.Object({}),
      async execute() {
        const result = await gmail.listLabels();
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "gmail_create_label",
      label: "Create Gmail Label",
      description: "Create a new custom Gmail label for inbox organization. Supports nested labels with '/' separator (e.g. 'Family/School'). The returned label ID can be used with email_label to tag emails.",
      parameters: Type.Object({
        name: Type.String({ description: "Label name (e.g. 'Travel', 'Family/School', 'Finance')." }),
        labelListVisibility: Type.Optional(Type.String({ description: "Visibility in label list: 'labelShow' (default), 'labelHide', or 'labelShowIfUnread'." })),
        messageListVisibility: Type.Optional(Type.String({ description: "Visibility in message list: 'show' (default) or 'hide'." })),
        backgroundColor: Type.Optional(Type.String({ description: "Background color hex (e.g. '#4986e7')." })),
        textColor: Type.Optional(Type.String({ description: "Text color hex (e.g. '#ffffff')." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.createLabel(params.name, {
          labelListVisibility: params.labelListVisibility,
          messageListVisibility: params.messageListVisibility,
          backgroundColor: params.backgroundColor,
          textColor: params.textColor,
        });
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "gmail_delete_label",
      label: "Delete Gmail Label",
      description: "Delete a custom Gmail label by its ID. System labels cannot be deleted. Use gmail_list_labels first to find the label ID.",
      parameters: Type.Object({
        labelId: Type.String({ description: "The Gmail label ID to delete (from gmail_list_labels)." }),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.deleteLabel(params.labelId);
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

function buildWebFetchTools(): ToolDefinition[] {
  return [
    {
      name: "web_fetch",
      label: "Web Fetch",
      description:
        "Fetch a web page and return its content as clean readable text. Use when you need to read the actual content of a URL — articles, documentation, blog posts, product pages, API docs, etc. Returns the page title, description, and full text content with HTML stripped. Handles HTML, JSON, and plain text responses. For searching the web (when you don't have a URL), use web_search instead.",
      parameters: Type.Object({
        url: Type.String({ description: "The full URL to fetch (must start with http:// or https://)" }),
        max_length: Type.Optional(Type.Number({ description: "Maximum content length in characters (default 80000). Use a smaller value like 20000 if you only need a summary or the beginning of a page." })),
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;
          const result = await webfetch.fetchPage(url, { maxLength: params.max_length });
          return {
            content: [{ type: "text" as const, text: webfetch.formatResult(result) }],
            details: { statusCode: result.statusCode, truncated: result.truncated },
          };
        } catch (err: any) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Failed to fetch "${params.url}": ${msg}` }],
            details: { error: msg },
          };
        }
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
      description: "Create a new calendar event. Can target a specific calendar by name (e.g. 'Reya' to match \"Reya's Schedule\"). Use calendar_list_available to see available calendars.",
      parameters: Type.Object({
        summary: Type.String({ description: "Event title" }),
        startTime: Type.String({ description: "Start time in ISO 8601 format (e.g. '2025-03-15T14:00:00')" }),
        endTime: Type.Optional(Type.String({ description: "End time in ISO 8601 format (defaults to 1 hour after start)" })),
        description: Type.Optional(Type.String({ description: "Event description" })),
        location: Type.Optional(Type.String({ description: "Event location" })),
        allDay: Type.Optional(Type.Boolean({ description: "Whether this is an all-day event" })),
        calendarName: Type.Optional(Type.String({ description: "Target calendar name to fuzzy-match (e.g. 'Reya', 'Pooja'). Defaults to primary calendar if omitted." })),
      }),
      async execute(_toolCallId, params) {
        const { summary, ...options } = params;
        const result = await calendar.createEvent(summary, options);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "calendar_list_available",
      label: "List Calendars",
      description: "List all available Google calendars with their names and access levels. Use this to find the correct calendar name for calendar_create.",
      parameters: Type.Object({}),
      async execute() {
        const cals = await calendar.listCalendars();
        if (cals.length === 0) return { content: [{ type: "text" as const, text: "No calendars found or not connected." }], details: {} };
        const lines = cals.map((c, i) => `${i + 1}. ${c.name} (${c.accessRole})${c.id === "primary" ? " [PRIMARY]" : ""}`);
        return { content: [{ type: "text" as const, text: `Available calendars (${cals.length}):\n\n${lines.join("\n")}` }], details: {} };
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
      description: "Read recent tweets/posts from an X (Twitter) user's timeline. Returns their latest public posts with engagement stats and view counts.",
      parameters: Type.Object({
        username: Type.String({ description: "X username (e.g. 'elonmusk') or profile URL" }),
        count: Type.Optional(Type.Number({ description: "Number of tweets to fetch (default 10, max 20)" })),
      }),
      async execute(_toolCallId, params) {
        const result = await twitter.getUserTimeline(params.username, params.count ?? 10);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "x_search",
      label: "X Search",
      description: "Search X (Twitter) for tweets matching a query. Returns matching posts with engagement stats and view counts. Useful for finding mentions, discussions, news, and sentiment on any topic.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query — supports keywords, phrases, @mentions, #hashtags, from:user, to:user, etc." }),
        count: Type.Optional(Type.Number({ description: "Number of results to return (default 10, max 20)" })),
        type: Type.Optional(Type.String({ description: "Search type: 'Latest' (most recent) or 'Top' (most popular). Default: 'Latest'" })),
      }),
      async execute(_toolCallId, params) {
        const searchType = (params.type === "Top" ? "Top" : "Latest") as "Latest" | "Top";
        const result = await twitter.searchTweets(params.query, params.count ?? 10, searchType);
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

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const ZILLOW_API_HOST = "private-zillow.p.rapidapi.com";

function buildZillowLocationSlug(location: string): string {
  return location
    .toLowerCase()
    .replace(/[,]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildZillowSearchUrl(location: string, filters?: {
  minPrice?: number; maxPrice?: number; minBeds?: number; minBaths?: number;
  sort?: string; page?: number;
}): string {
  const slug = buildZillowLocationSlug(location);
  const filterState: any = {
    tow: { value: false }, mf: { value: false }, con: { value: false },
    land: { value: false }, apa: { value: false }, manu: { value: false }, apco: { value: false },
  };
  if (filters?.minPrice || filters?.maxPrice) {
    filterState.price = {};
    if (filters.minPrice) filterState.price.min = filters.minPrice;
    if (filters.maxPrice) filterState.price.max = filters.maxPrice;
  }
  if (filters?.minBeds) filterState.beds = { min: filters.minBeds };
  if (filters?.minBaths) filterState.baths = { min: filters.minBaths };
  if (filters?.sort) filterState.sort = { value: filters.sort === "Newest" ? "days" : filters.sort };
  const searchQueryState: any = { filterState };
  if (filters?.page && filters.page > 1) {
    searchQueryState.pagination = { currentPage: filters.page };
  }
  const qs = encodeURIComponent(JSON.stringify(searchQueryState));
  return `https://www.zillow.com/${slug}/?searchQueryState=${qs}`;
}

function normalizeZillowUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `https://www.zillow.com${url.startsWith("/") ? "" : "/"}${url}`;
}

function getZillowResults(data: any): any[] {
  return data?.Results || data?.results || [];
}

function getZillowTotalResults(data: any, fallbackCount: number): number {
  return data?.total_results || data?.totalResultCount || fallbackCount;
}

async function fetchZillow(endpoint: string, params: Record<string, string>): Promise<any> {
  const url = `https://${ZILLOW_API_HOST}/${endpoint}?${new URLSearchParams(params)}`;
  let resp = await fetch(url, {
    headers: { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": ZILLOW_API_HOST },
  });
  if (resp.status === 429) {
    await new Promise(r => setTimeout(r, 1500));
    resp = await fetch(url, {
      headers: { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": ZILLOW_API_HOST },
    });
  }
  if (!resp.ok) throw new Error(`Zillow API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

function buildRealEstateTools(): ToolDefinition[] {
  if (!RAPIDAPI_KEY) return [];
  return [
    {
      name: "property_search",
      label: "Property Search",
      description: "Search Zillow for property listings by location with filters. Returns structured listing data including address, price, beds, baths, sqft, and listing URLs.",
      parameters: Type.Object({
        location: Type.String({ description: "Location to search — city and state, zip code, or neighborhood (e.g. 'Montclair, NJ', '07042', 'Garden City, NY')" }),
        minPrice: Type.Optional(Type.Number({ description: "Minimum price filter (e.g. 1500000)" })),
        maxPrice: Type.Optional(Type.Number({ description: "Maximum price filter (e.g. 2000000)" })),
        minBeds: Type.Optional(Type.Number({ description: "Minimum bedrooms (e.g. 5)" })),
        minBaths: Type.Optional(Type.Number({ description: "Minimum bathrooms (e.g. 3)" })),
        sort: Type.Optional(Type.String({ description: "Sort order: 'Newest', 'Price_High_Low', 'Price_Low_High', 'Bedrooms', 'Bathrooms'" })),
        page: Type.Optional(Type.Number({ description: "Page number for pagination (default 1)" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const zillowUrl = buildZillowSearchUrl(params.location, {
            minPrice: params.minPrice, maxPrice: params.maxPrice,
            minBeds: params.minBeds, minBaths: params.minBaths,
            sort: params.sort, page: params.page,
          });
          const data = await fetchZillow("search/byurl", { url: zillowUrl });
          const props = getZillowResults(data);
          if (props.length === 0) return { content: [{ type: "text" as const, text: `No properties found in ${params.location} matching criteria. Try broadening filters or checking the location name.` }], details: {} };
          const summary = props.slice(0, 20).map((p: any) => {
            const info = p.hdpData?.homeInfo || {};
            return {
              address: p.address,
              price: p.unformattedPrice ? `$${p.unformattedPrice.toLocaleString()}` : (p.price || "N/A"),
              beds: p.beds ?? info.bedrooms,
              baths: p.baths ?? info.bathrooms,
              sqft: info.livingArea || p.area,
              lotSize: info.lotAreaValue ? `${info.lotAreaValue} ${info.lotAreaUnit || "sqft"}` : "N/A",
              zpid: p.zpid,
              daysOnZillow: info.daysOnZillow ?? p.variableData?.text,
              listingUrl: normalizeZillowUrl(p.detailUrl),
              propertyType: info.homeType || p.statusType,
              listingStatus: p.statusText || info.homeStatus,
            };
          });
          return { content: [{ type: "text" as const, text: JSON.stringify({ totalResults: getZillowTotalResults(data, props.length), resultsReturned: summary.length, properties: summary }, null, 2) }], details: {} };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Property search failed: ${err.message}` }], details: {} };
        }
      },
    },
    {
      name: "property_details",
      label: "Property Details",
      description: "Get detailed information about a specific property from Zillow. Provide the zpid and the city/state location from property_search results. Returns price, beds, baths, sqft, zestimate, open house info, and listing details.",
      parameters: Type.Object({
        zpid: Type.Number({ description: "Zillow property ID (from property_search results)" }),
        location: Type.String({ description: "City and state where the property is located (e.g. 'Montclair, NJ') — needed to search the area and find the property" }),
        address: Type.Optional(Type.String({ description: "Full property address for display (e.g. '10 Mountain Ter, Montclair, NJ 07043')" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const zillowUrl = buildZillowSearchUrl(params.location);
          const data = await fetchZillow("search/byurl", { url: zillowUrl });
          const allResults = getZillowResults(data);
          const match = allResults.find((r: any) => String(r.zpid) === String(params.zpid));
          if (!match) {
            return { content: [{ type: "text" as const, text: `Property zpid ${params.zpid} not found in ${params.location} listings (searched ${allResults.length} results). The listing may have been removed or the location may not match. Try property_search to find current listings.` }], details: {} };
          }
          const info = match.hdpData?.homeInfo || {};
          const details: any = {
            address: match.address || info.streetAddress,
            price: match.unformattedPrice ? `$${match.unformattedPrice.toLocaleString()}` : (match.price || "N/A"),
            beds: match.beds ?? info.bedrooms,
            baths: match.baths ?? info.bathrooms,
            sqft: info.livingArea || match.area,
            lotSize: info.lotAreaValue ? `${info.lotAreaValue} ${info.lotAreaUnit || "sqft"}` : "N/A",
            propertyType: info.homeType,
            daysOnZillow: info.daysOnZillow,
            listingUrl: normalizeZillowUrl(match.detailUrl) || `https://www.zillow.com/homedetails/${params.zpid}_zpid/`,
            zestimate: info.zestimate ? `$${info.zestimate.toLocaleString()}` : "N/A",
            rentZestimate: info.rentZestimate ? `$${info.rentZestimate.toLocaleString()}/mo` : "N/A",
            homeStatus: info.homeStatus || match.statusText,
            listingStatus: match.statusText,
          };
          if (info.openHouse || match.flexFieldText) {
            details.openHouse = info.openHouse || match.flexFieldText;
          }
          if (info.open_house_info?.open_house_showing?.length > 0) {
            details.openHouseShowings = info.open_house_info.open_house_showing.map((s: any) => ({
              start: new Date(s.open_house_start).toLocaleString("en-US", { timeZone: "America/New_York" }),
              end: new Date(s.open_house_end).toLocaleString("en-US", { timeZone: "America/New_York" }),
            }));
          }
          if (info.listing_sub_type) {
            details.listingSubType = info.listing_sub_type;
          }
          details.note = "For school ratings, walkability, price history, and tax details, use web_search with the Zillow listing URL or the property address.";
          return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details: {} };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Property details failed: ${err.message}` }], details: {} };
        }
      },
    },
    {
      name: "neighborhood_search",
      label: "Neighborhood Search",
      description: "Search for neighborhood information including demographics, school ratings, and nearby amenities for a given location. Useful for evaluating walkability, schools, and community character.",
      parameters: Type.Object({
        location: Type.String({ description: "Location to research — city and state or zip code (e.g. 'Montclair, NJ', '07042')" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const zillowUrl = buildZillowSearchUrl(params.location);
          const data = await fetchZillow("search/byurl", { url: zillowUrl });
          const props = getZillowResults(data);
          const result: any = {
            location: params.location,
            totalListings: getZillowTotalResults(data, props.length),
            medianPrice: null as string | null,
          };
          if (props.length > 0) {
            const prices = props.filter((p: any) => p.unformattedPrice).map((p: any) => p.unformattedPrice).sort((a: number, b: number) => a - b);
            if (prices.length > 0) result.medianPrice = `$${prices[Math.floor(prices.length / 2)].toLocaleString()}`;
            const sqftPrices = props.filter((p: any) => p.hdpData?.homeInfo?.livingArea && p.unformattedPrice).map((p: any) => p.unformattedPrice / p.hdpData.homeInfo.livingArea);
            if (sqftPrices.length > 0) result.avgPricePerSqft = `$${Math.round(sqftPrices.reduce((a: number, b: number) => a + b, 0) / sqftPrices.length)}`;
          }
          result.note = "Use web_search for detailed school ratings (GreatSchools), walkability scores, and neighborhood character. Use property_details with a specific zpid for school data near a property.";
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: {} };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Neighborhood search failed: ${err.message}` }], details: {} };
        }
      },
    },
    {
      name: "redfin_search",
      label: "Redfin Property Search",
      description: "Search Redfin for property listings using a Redfin search URL with filters. Use properties/auto-complete first to get the correct region URL, then build a full search URL. Returns listings with address, price, beds, baths, sqft, listing remarks, key facts, and days on market.",
      parameters: Type.Object({
        url: Type.String({ description: "Full Redfin search URL with filters, e.g. 'https://www.redfin.com/city/35939/NJ/Montclair/filter/min-price=1.5M,max-price=2M,min-beds=5,min-baths=3'. Build from auto-complete results: /city/{id}/{state}/{city}/filter/min-price=X,max-price=X,min-beds=X,min-baths=X" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const resp = await fetch(`https://redfin-com-data.p.rapidapi.com/property/search-url?url=${encodeURIComponent(params.url)}`, {
            headers: { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": "redfin-com-data.p.rapidapi.com" },
          });
          if (!resp.ok) return { content: [{ type: "text" as const, text: `Redfin API error: ${resp.status} ${resp.statusText}` }], details: {} };
          const data = await resp.json();
          const homes = data?.data?.nearbyHomes?.homes || data?.data?.homes || [];
          if (homes.length === 0) return { content: [{ type: "text" as const, text: `No Redfin listings found for this search. Try broadening filters or checking the URL.` }], details: {} };
          const summary = homes.slice(0, 20).map((h: any) => ({
            address: `${h.streetLine?.value || ""}, ${h.city || ""}, ${h.state || ""} ${h.zip || ""}`.trim(),
            price: h.price?.value ? `$${h.price.value.toLocaleString()}` : "N/A",
            beds: h.beds,
            baths: h.baths,
            sqft: h.sqFt?.value || null,
            lotSize: h.lotSize?.value ? `${h.lotSize.value.toLocaleString()} sqft` : null,
            daysOnMarket: h.dom?.value ?? null,
            listingId: h.listingId,
            redfinUrl: h.url ? `https://www.redfin.com${h.url}` : null,
            mlsId: h.mlsId?.value || null,
            mlsStatus: h.mlsStatus,
            propertyType: h.propertyType,
            listingRemarks: h.listingRemarks ? h.listingRemarks.substring(0, 300) : null,
            keyFacts: h.keyFacts?.map((f: any) => f.description) || [],
            listingTags: h.listingTags || [],
            broker: h.listingBroker?.name || null,
            lat: h.latLong?.value?.latitude,
            lng: h.latLong?.value?.longitude,
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify({ source: "Redfin", totalResults: homes.length, resultsReturned: summary.length, properties: summary }, null, 2) }], details: {} };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Redfin search failed: ${err.message}` }], details: {} };
        }
      },
    },
    {
      name: "redfin_details",
      label: "Redfin Property Details",
      description: "Get detailed Redfin property information including photos, room descriptions, features, and market data. Use the property URL from redfin_search results (e.g. '/NJ/Glen-Ridge/210-Baldwin-St-07028/home/36166097').",
      parameters: Type.Object({
        url: Type.String({ description: "Redfin property URL path from search results (e.g. '/NJ/Glen-Ridge/210-Baldwin-St-07028/home/36166097')" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const resp = await fetch(`https://redfin-com-data.p.rapidapi.com/property/detail?url=${encodeURIComponent(params.url)}`, {
            headers: { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": "redfin-com-data.p.rapidapi.com" },
          });
          if (!resp.ok) return { content: [{ type: "text" as const, text: `Redfin API error: ${resp.status} ${resp.statusText}` }], details: {} };
          const data = await resp.json();
          if (!data?.data) return { content: [{ type: "text" as const, text: `No details found for this property URL. Ensure the URL is a property path like '/NJ/City/123-Main-St-07028/home/12345678'.` }], details: {} };
          const d = data.data;
          const numericKey = Object.keys(d).find(k => /^\d+$/.test(k));
          const photoSection = numericKey ? d[numericKey] : null;
          const tagsByPhoto = (photoSection && typeof photoSection === "object" && photoSection.tagsByPhotoId) ? photoSection.tagsByPhotoId : {};
          const photoSummary = Object.values(tagsByPhoto).slice(0, 10).map((p: any) => ({
            caption: p.shortCaption || p.longCaption || "",
            tags: p.tags || [],
            url: p.photoUrl || "",
          }));
          const affordability = d.affordability || {};
          const result: any = {
            source: "Redfin",
            propertyUrl: params.url,
            listingId: photoSection?.listingId || null,
            photoCount: photoSection?.includedFilterTags?.All || Object.keys(tagsByPhoto).length || 0,
            photos: photoSummary.length > 0 ? photoSummary : "No photos available",
          };
          if (affordability.bedroomAggregates) {
            result.marketData = {
              activeListingTrend: affordability.activeListingYearlyTrend != null ? `${affordability.activeListingYearlyTrend.toFixed(1)}%` : null,
              bedroomBreakdown: (affordability.bedroomAggregates || []).filter((b: any) => b.aggregate?.listPriceMedian).map((b: any) => ({
                beds: b.aggregationType,
                medianPrice: `$${b.aggregate.listPriceMedian.toLocaleString()}`,
                activeListings: b.aggregate.activeListingsCount,
              })),
            };
          }
          const knownKeys = Object.keys(d).filter(k => k !== numericKey && k !== "affordability");
          if (knownKeys.length > 0) {
            result.additionalSections = knownKeys;
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: {} };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Redfin details failed: ${err.message}` }], details: {} };
        }
      },
    },
    {
      name: "redfin_autocomplete",
      label: "Redfin Location Lookup",
      description: "Look up a location on Redfin to get the correct region ID and URL path for use with redfin_search. Returns matching cities, neighborhoods, and schools.",
      parameters: Type.Object({
        query: Type.String({ description: "Location to look up (e.g. 'Montclair, NJ', 'Upper Saddle River', 'Princeton NJ')" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const resp = await fetch(`https://redfin-com-data.p.rapidapi.com/properties/auto-complete?query=${encodeURIComponent(params.query)}`, {
            headers: { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": "redfin-com-data.p.rapidapi.com" },
          });
          if (!resp.ok) return { content: [{ type: "text" as const, text: `Redfin API error: ${resp.status} ${resp.statusText}` }], details: {} };
          const data = await resp.json();
          const rows = data?.data?.flatMap((section: any) => section.rows || []) || [];
          if (rows.length === 0) return { content: [{ type: "text" as const, text: `No Redfin locations found for "${params.query}". Try a different spelling.` }], details: {} };
          const results = rows.slice(0, 10).map((r: any) => ({
            name: r.name,
            subName: r.subName,
            url: r.url,
            id: r.id,
            type: r.type,
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify({ source: "Redfin", note: "Use the 'url' field to build redfin_search URLs: https://www.redfin.com{url}/filter/min-price=X,max-price=X,min-beds=X,min-baths=X", locations: results }, null, 2) }], details: {} };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Redfin autocomplete failed: ${err.message}` }], details: {} };
        }
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

        entry.pendingInterviewForm = {
          toolCallId,
          title: params.title,
          description: params.description,
          questions: params.questions,
        };

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
              entry.pendingInterviewForm = undefined;
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

function buildWebPublishTools(): ToolDefinition[] {
  const PUBLISH_SCRIPT = path.join(PROJECT_ROOT, "scripts", "herenow-publish.sh");

  return [
    {
      name: "web_publish",
      label: "Publish Temp Page",
      description:
        "Publish a file or folder as a temporary, public shareable link via here.now. Use when the user says: 'temp page', 'temporary', 'quick share', 'send a link', 'share this with someone', 'public link', or needs a URL to send to others. NOT for personal/private pages — use web_save for those. Sites expire in 24h without an API key. Supports HTML, images, PDFs, any file. Paths resolve from project root first, then vault.",
      parameters: Type.Object({
        path: Type.String({
          description:
            "Path to the file or directory to publish. Can be a project-relative path or a vault-relative path (e.g. 'bahamas-trip' resolves to data/vault/bahamas-trip). For HTML sites, the directory should contain index.html at its root.",
        }),
        slug: Type.Optional(
          Type.String({
            description:
              "Slug of an existing site to update (e.g. 'bright-canvas-a7k2'). Omit to create a new site.",
          })
        ),
      }),
      async execute(_toolCallId, params) {
        try {
          let targetPath = path.resolve(params.path);
          if (!fs.existsSync(targetPath)) {
            const vaultPath = path.join(VAULT_DIR, params.path);
            if (fs.existsSync(vaultPath)) {
              targetPath = vaultPath;
            } else {
              return {
                content: [{ type: "text" as const, text: `Error: Path "${params.path}" does not exist (checked project root and vault).` }],
                details: {},
              };
            }
          }

          const realTarget = fs.realpathSync(targetPath);
          const projectReal = fs.realpathSync(PROJECT_ROOT);
          if (!realTarget.startsWith(projectReal + "/") && realTarget !== projectReal) {
            return {
              content: [{ type: "text" as const, text: `Error: Can only publish files within the project directory.` }],
              details: {},
            };
          }

          const blocked = [".env", "auth.json", "credentials", ".herenow"];
          const relPath = path.relative(projectReal, realTarget);
          if (blocked.some(b => relPath.split("/").includes(b) || relPath === b)) {
            return {
              content: [{ type: "text" as const, text: `Error: Cannot publish sensitive files.` }],
              details: {},
            };
          }

          if (params.slug && !/^[a-z0-9][a-z0-9-]*$/.test(params.slug)) {
            return {
              content: [{ type: "text" as const, text: `Error: Invalid slug format. Use only lowercase letters, numbers, and hyphens.` }],
              details: {},
            };
          }

          const args = [PUBLISH_SCRIPT, realTarget];
          if (params.slug) {
            args.push("--slug", params.slug);
          }
          args.push("--client", "darknode");

          const { execFileSync } = await import("child_process");
          const result = execFileSync("bash", args, {
            encoding: "utf-8",
            timeout: 60_000,
            cwd: PROJECT_ROOT,
          });

          const urlMatch = result.match(/https:\/\/[^\s]+\.here\.now\/?/);
          const siteUrl = urlMatch ? urlMatch[0] : null;

          let response = result.trim();
          if (siteUrl) {
            response = `Published successfully!\n\nLive URL: ${siteUrl}\n\n${response}`;
          }

          return {
            content: [{ type: "text" as const, text: response }],
            details: { siteUrl },
          };
        } catch (err: any) {
          const stderr = err.stderr ? err.stderr.toString() : "";
          const stdout = err.stdout ? err.stdout.toString() : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `Publish failed:\n${stderr || stdout || err.message}`,
              },
            ],
            details: { error: true },
          };
        }
      },
    },
    {
      name: "web_save",
      label: "Save Personal Page",
      description:
        "Save HTML as a permanent, password-protected personal page on rickin.live/pages/<slug>. Use when the user says: 'personal page', 'my page', 'page on my site', 'private page', 'create a page', 'put on rickin.live', 'dashboard page', 'report page', 'web page', or wants a rendered HTML page (not a note). This is for HTML pages — NOT for saving text/notes to the knowledge base (use notes_create for that). Default when page-related request has no 'temp'/'share'/'public' keywords. NOT for sharing with others — use web_publish for temporary public links.",
      parameters: Type.Object({
        slug: Type.String({
          description:
            "URL-friendly name for the page (lowercase, hyphens, no spaces). E.g. 'moody-report' becomes rickin.live/pages/moody-report",
        }),
        html: Type.String({
          description: "The full HTML content to save. Should be a complete HTML document with <!DOCTYPE html>, <head>, and <body>.",
        }),
      }),
      async execute(_toolCallId, params) {
        try {
          const slug = params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/--+/g, "-").replace(/^-|-$/g, "");
          if (!slug) {
            return { content: [{ type: "text" as const, text: "Error: Invalid slug — must contain at least one alphanumeric character." }], details: {} };
          }

          const pagesDir = path.join(PROJECT_ROOT, "data", "pages");
          if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });

          const filePath = path.join(pagesDir, `${slug}.html`);
          const existed = fs.existsSync(filePath);
          fs.writeFileSync(filePath, params.html, "utf-8");

          const domain = process.env.REPLIT_DEPLOYMENT_URL || process.env.REPLIT_DEV_DOMAIN || "rickin.live";
          const protocol = domain.includes("localhost") ? "http" : "https";
          const pageUrl = `${protocol}://${domain}/pages/${slug}`;

          return {
            content: [{
              type: "text" as const,
              text: `✅ Page ${existed ? "updated" : "saved"}!\n\nURL: ${pageUrl}\n\nThis page is password-protected behind your login. Visit rickin.live/pages to see all saved pages.`,
            }],
            details: { pageUrl, slug },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to save page: ${err.message}` }],
            details: { error: true },
          };
        }
      },
    },
    {
      name: "web_list_pages",
      label: "List Saved Pages",
      description: "List all saved pages on rickin.live/pages. Returns slugs, file sizes, and last modified dates.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const pagesDir = path.join(PROJECT_ROOT, "data", "pages");
          if (!fs.existsSync(pagesDir)) {
            return { content: [{ type: "text" as const, text: "No pages saved yet." }], details: {} };
          }
          const files = fs.readdirSync(pagesDir).filter(f => f.endsWith(".html")).sort();
          if (files.length === 0) {
            return { content: [{ type: "text" as const, text: "No pages saved yet." }], details: {} };
          }
          const domain = process.env.REPLIT_DEPLOYMENT_URL || process.env.REPLIT_DEV_DOMAIN || "rickin.live";
          const protocol = domain.includes("localhost") ? "http" : "https";
          const list = files.map(f => {
            const slug = f.replace(/\.html$/, "");
            const stat = fs.statSync(path.join(pagesDir, f));
            const sizeKB = Math.round(stat.size / 1024);
            const date = stat.mtime.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            return `- ${slug} (${sizeKB}KB, ${date}) — ${protocol}://${domain}/pages/${slug}`;
          }).join("\n");
          return {
            content: [{ type: "text" as const, text: `${files.length} saved page(s):\n\n${list}\n\nAll pages: ${protocol}://${domain}/pages` }],
            details: {},
          };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Error listing pages: ${err.message}` }], details: {} };
        }
      },
    },
    {
      name: "web_delete_page",
      label: "Delete Saved Page",
      description: "Delete a previously saved page from rickin.live/pages.",
      parameters: Type.Object({
        slug: Type.String({ description: "The slug of the page to delete." }),
      }),
      async execute(_toolCallId, params) {
        try {
          const slug = params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/--+/g, "-").replace(/^-|-$/g, "");
          if (!slug) {
            return { content: [{ type: "text" as const, text: "Error: Invalid slug." }], details: {} };
          }
          const filePath = path.join(PROJECT_ROOT, "data", "pages", `${slug}.html`);
          if (!fs.existsSync(filePath)) {
            return { content: [{ type: "text" as const, text: `Page "${slug}" not found.` }], details: {} };
          }
          fs.unlinkSync(filePath);
          return { content: [{ type: "text" as const, text: `✅ Page "${slug}" deleted.` }], details: {} };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Failed to delete page: ${err.message}` }], details: {} };
        }
      },
    },
  ];
}

function buildAgentTools(allToolsFn: () => ToolDefinition[], sessionId: string): ToolDefinition[] {
  return [
    {
      name: "delegate",
      label: "Delegate to Agent",
      description:
        "Delegate a complex task to a specialist agent. The agent will work independently using its own tools and return a comprehensive result. Use this for multi-step research, project planning, deep analysis, email drafting, or vault organization.",
      parameters: Type.Object({
        agent: Type.String({ description: "The specialist agent ID. Available agents: 'deep-researcher' (web research), 'project-planner' (project plans), 'email-drafter' (compose emails), 'analyst' (markets/stocks), 'moodys' (Moody's/ValidMind/work projects — use for ANY work-related task), 'real-estate' (property search), 'nutritionist' (meal planning), 'family-planner' (financial/legal planning), 'knowledge-organizer' (vault management)" }),
        task: Type.String({ description: "Clear description of what the agent should do" }),
        context: Type.Optional(Type.String({ description: "Additional context the agent needs (e.g. previous conversation details, specific requirements)" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const sessionEntry = sessions.get(sessionId);
          const modelOverride = sessionEntry?.modelMode === "max" ? MAX_MODEL_ID : undefined;
          const result = await runSubAgent({
            agentId: params.agent,
            task: params.task,
            context: params.context,
            allTools: allToolsFn() as any,
            apiKey: ANTHROPIC_KEY,
            model: modelOverride,
          });
          const details: any = { agent: result.agentId, toolsUsed: result.toolsUsed, durationMs: result.durationMs };
          if (result.error) details.error = result.error;
          if (result.timedOut) details.timedOut = true;
          return {
            content: [{ type: "text" as const, text: result.response }],
            details,
          };
        } catch (err: any) {
          console.error(`[delegate] Unhandled error delegating to agent: ${err.message}`);
          return {
            content: [{ type: "text" as const, text: `Agent delegation failed: ${err.message}. Try running the tools directly instead of delegating.` }],
            details: { error: err.message, unhandled: true },
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

type ModelMode = "auto" | "fast" | "full" | "max";

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
  currentToolName: string | null;
  modelMode: ModelMode;
  activeModelName: string;
  interviewWaiter?: InterviewWaiter;
  pendingInterviewForm?: { toolCallId: string; title?: string; description?: string; questions: any[] };
  isAgentRunning: boolean;
  pendingMessages: PendingMessage[];
  startupContext?: string;
}
const sessions = new Map<string, SessionEntry>();

const FAST_MODEL_ID = "claude-haiku-4-5-20251001";
const FULL_MODEL_ID = "claude-sonnet-4-6";
const MAX_MODEL_ID = "claude-opus-4-6";

const FAST_PATTERNS = [
  /^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|thanks|thank you|ok|okay|got it|cool|nice|great)\b/i,
  /^what('s| is) (the )?(time|date|day)\b/i,
  /^(show|check|get|list|read)\s+(my\s+)?(tasks?|todos?|email|calendar|events?|weather|stock|price|portfolio|watchlist|notes?)\b/i,
  /^(add|create|complete|delete|remove)\s+(a\s+)?(task|todo|note)\b/i,
  /^(how'?s|what'?s)\s+(the\s+)?(weather|market|stock)\b/i,
  /^(remind|timer|alarm|set)\b/i,
];

const MAX_PATTERNS = [
  /\b(project|strategy|architecture|roadmap|proposal|initiative)\b/i,
  /\b(sprint|milestone|deliverable|stakeholder|requirements?)\b/i,
  /\b(analysis|analyze|evaluate|assess|audit|review|compare)\b/i,
  /\b(forecast|budget|revenue|investment|valuation|financial)\b/i,
  /\b(presentation|deck|report|memo|brief|whitepaper)\b/i,
  /\b(moody'?s|validmind|data\s*moat|competitive|acquisition)\b/i,
  /\b(design|implement|build|develop|engineer|refactor)\b/i,
  /\b(plan\s+(out|for|the)|create\s+a\s+plan|help\s+me\s+(plan|think|figure))\b/i,
  /\b(research|deep\s*dive|investigate|explore\s+(the|how|why))\b/i,
  /\b(retirement|estate|wealth|portfolio\s+(review|strategy|allocation))\b/i,
];

function classifyIntent(message: string): "fast" | "full" | "max" {
  const trimmed = message.trim();
  if (trimmed.length < 80) {
    for (const pattern of FAST_PATTERNS) {
      if (pattern.test(trimmed)) return "fast";
    }
  }
  if (trimmed.length < 20 && !trimmed.includes("?")) return "fast";
  for (const pattern of MAX_PATTERNS) {
    if (pattern.test(trimmed)) return "max";
  }
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
        entry.currentToolName = null;
        processingQueue.delete(sessionId);
        processNextPendingMessage(sessionId);
      }).catch(() => {
        console.log(`[prompt] queued background prompt failed after ${((Date.now() - queuedPromptStart) / 1000).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        processingQueue.delete(sessionId);
        processNextPendingMessage(sessionId);
      });
      return;
    }
    entry.isAgentRunning = false;
    entry.currentToolName = null;
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

const AUTH_PUBLIC_PATHS = new Set(["/login.html", "/login.css", "/api/login", "/health", "/manifest.json", "/baby-manifest.json", "/icons/icon-180.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/baby/icon-180.png", "/icons/baby/icon-192.png", "/icons/baby/icon-512.png", "/api/healthcheck"]);

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!APP_PASSWORD) { next(); return; }
  if (AUTH_PUBLIC_PATHS.has(req.path)) { next(); return; }
  if (req.path === "/api/config/tunnel-url") { next(); return; }
  if (req.path === "/api/gmail/callback") { next(); return; }
  if (req.path === "/api/gmail/auth") { next(); return; }

  const token = req.signedCookies?.auth;
  if (token && USERS[token]) { (req as any).user = token; next(); return; }
  if (token === "authenticated") { (req as any).user = "rickin"; next(); return; }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7);
    for (const [uname, u] of Object.entries(USERS)) {
      if (u.password && bearerToken === u.password) { (req as any).user = uname; next(); return; }
    }
  }

  const queryUser = req.query.user as string | undefined;
  const queryToken = req.query.token as string | undefined;
  if (queryUser && queryToken && USERS[queryUser.toLowerCase()]?.password === queryToken) {
    (req as any).user = queryUser.toLowerCase(); next(); return;
  }

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
  const { username, password } = req.body as { username?: string; password?: string };

  let matchedUser: string | null = null;
  if (username && USERS[username.toLowerCase()]) {
    const u = USERS[username.toLowerCase()];
    if (password && u.password && password === u.password) matchedUser = username.toLowerCase();
  } else if (!username && password && password === APP_PASSWORD) {
    matchedUser = "rickin";
  }

  if (!matchedUser) {
    res.status(401).json({ error: "ACCESS DENIED" });
    return;
  }

  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("auth", matchedUser, {
    signed: true,
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  const user = USERS[matchedUser];
  const redirect = matchedUser === "pooja" ? "/pages/baby-dashboard" : "/";
  res.json({ ok: true, displayName: user.displayName, redirect });
});

app.get("/api/me", (req: Request, res: Response) => {
  const token = req.signedCookies?.auth;
  if (token && USERS[token]) {
    res.json({ username: token, displayName: USERS[token].displayName });
  } else if (token === "authenticated") {
    res.json({ username: "rickin", displayName: "Rickin" });
  } else {
    res.status(401).json({ error: "Not logged in" });
  }
});

app.get("/api/logout", (_req: Request, res: Response) => {
  res.clearCookie("auth");
  res.redirect("/login.html");
});

app.use(express.static(PUBLIC_DIR));

const PAGES_DIR = path.join(PROJECT_ROOT, "data", "pages");
if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR, { recursive: true });

app.get("/pages", (_req: Request, res: Response) => {
  try {
    const files = fs.readdirSync(PAGES_DIR).filter(f => f.endsWith(".html")).sort();
    if (files.length === 0) {
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages — RICKIN</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;max-width:600px;margin:0 auto}h1{font-size:1.4rem;color:#fff}p{color:#888}</style></head><body><h1>Pages</h1><p>No pages published yet.</p></body></html>`);
      return;
    }
    const items = files.map(f => {
      const slug = f.replace(/\.html$/, "");
      const stat = fs.statSync(path.join(PAGES_DIR, f));
      const date = stat.mtime.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return `<a href="/pages/${slug}">${slug}</a><span class="date">${date}</span>`;
    }).join("");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages — RICKIN</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;max-width:600px;margin:0 auto}h1{font-size:1.4rem;color:#fff;margin-bottom:1.5rem}a{display:block;color:#7cacf8;text-decoration:none;padding:.75rem 0;border-bottom:1px solid #222;font-size:1rem}a:hover{color:#aac8ff}.date{float:right;color:#666;font-size:.85rem}</style></head><body><h1>Pages</h1>${items}</body></html>`);
  } catch (err) {
    res.status(500).send("Error loading pages.");
  }
});

const BABY_SHEET_ID = "1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU";
let babyDashboardCache: { data: any; timestamp: number } | null = null;
const BABY_CACHE_TTL = 60_000;

app.get("/api/baby-dashboard/data", async (_req: Request, res: Response) => {
  try {
    if (babyDashboardCache && Date.now() - babyDashboardCache.timestamp < BABY_CACHE_TTL) {
      res.json(babyDashboardCache.data);
      return;
    }

    if (!gmail.isConnected()) {
      res.status(503).json({ error: "google_disconnected", message: "Google not connected" });
      return;
    }

    const tabErrors: string[] = [];
    const readTab = async (range: string): Promise<string> => {
      try {
        const result = await gws.sheetsRead(BABY_SHEET_ID, range);
        if (result.includes("Error") || result.includes("not connected") || result.includes("expired")) {
          tabErrors.push(range.split("!")[0]);
          return "";
        }
        return result;
      } catch {
        tabErrors.push(range.split("!")[0]);
        return "";
      }
    };

    const [timelineResult, apptResult, tasksResult, shoppingResult, namesResult] = await Promise.all([
      readTab("Timeline!A1:F19"),
      readTab("Appointments!A1:E14"),
      readTab("To-Do List!A1:F23"),
      readTab("Shopping List!A1:F40"),
      readTab("Baby Names!A1:F16"),
    ]);

    function parseRows(raw: string): string[][] {
      if (!raw || raw.includes("No data") || raw.includes("Error") || raw.includes("not connected")) return [];
      return raw.split("\n").filter(l => l.startsWith("Row ")).map(l => {
        const content = l.replace(/^Row \d+: /, "");
        return content.split(" | ");
      });
    }

    const timelineRows = parseRows(timelineResult);
    let currentWeekData: any = null;
    const timelineWeeks: any[] = [];
    timelineRows.slice(1).forEach(r => {
      const week = parseInt(r[0]?.trim()) || 0;
      const status = (r[5] || "").trim();
      const entry = {
        week,
        dates: r[1]?.trim() || "",
        trimester: r[2]?.trim() || "",
        development: r[3]?.trim() || "",
        milestone: r[4]?.trim() || "",
        status,
      };
      timelineWeeks.push(entry);
      if (status.includes("✅") && status.toLowerCase().includes("current")) {
        currentWeekData = entry;
      }
    });

    const apptRows = parseRows(apptResult);
    const appointments = apptRows.slice(1).filter(r => r[0]).map(r => {
      const status = (r[4] || "").trim();
      return {
        date: r[0]?.trim() || "",
        type: r[1]?.trim() || "",
        provider: r[2]?.trim() || "",
        notes: r[3]?.trim() || "",
        status,
        done: status.includes("✅"),
      };
    });

    const taskRows = parseRows(tasksResult);
    const tasks = taskRows.slice(1).filter(r => r[0]).map(r => {
      const status = (r[4] || "").trim();
      return {
        text: r[0]?.trim() || "",
        category: r[1]?.trim() || "",
        dueWeek: r[2]?.trim() || "",
        owner: r[3]?.trim() || "",
        status,
        notes: r[5]?.trim() || "",
        done: status.includes("✅"),
        inProgress: status.includes("🔄"),
      };
    });

    const shoppingRows = parseRows(shoppingResult);
    const shoppingItems = shoppingRows.slice(1).filter(r => r[1]);
    const shopping = shoppingItems.map(r => {
      const status = (r[3] || "").trim();
      return {
        category: r[0]?.trim() || "",
        item: r[1]?.trim() || "",
        priority: r[2]?.trim() || "",
        status,
        budget: r[4]?.trim() || "",
        notes: r[5]?.trim() || "",
        done: status.includes("✅"),
        inProgress: status.includes("🔄"),
      };
    });

    const nameRows = parseRows(namesResult);
    const favNames: { name: string; meaning: string; origin: string; notes: string }[] = [];
    const otherNames: { name: string; meaning: string; origin: string; notes: string }[] = [];
    nameRows.slice(1).filter(r => r[0]).forEach(r => {
      const nameVal = (r[0] || "").trim();
      if (nameVal === "⭐ FAVORITES" || nameVal === "📋 SHORTLIST" || !nameVal) return;
      const entry = {
        name: nameVal,
        meaning: r[1]?.trim() || "",
        origin: r[2]?.trim() || "",
        notes: r[5]?.trim() || "",
      };
      const rickinFav = (r[3] || "").trim();
      const poojaFav = (r[4] || "").trim();
      if (rickinFav.includes("⭐") || rickinFav.includes("🆕") || poojaFav.includes("⭐")) {
        favNames.push(entry);
      } else {
        otherNames.push(entry);
      }
    });

    const tasksDone = tasks.filter(t => t.done).length;
    const shoppingDone = shopping.filter(s => s.done).length;
    const apptsUpcoming = appointments.filter(a => !a.done && !a.status.includes("🎊")).length;
    const allFailed = tabErrors.length === 5;

    if (allFailed) {
      res.status(502).json({ error: "sheets_unavailable", message: "All sheet reads failed", errors: tabErrors });
      return;
    }

    const result = {
      timeline: { currentWeek: currentWeekData, weeks: timelineWeeks },
      appointments,
      tasks,
      shopping,
      names: { fav: favNames, other: otherNames },
      counters: {
        shoppingDone: `${shoppingDone}/${shoppingItems.length}`,
        tasksDone: `${tasksDone}/${tasks.length}`,
        apptsUpcoming,
      },
      sync: {
        source: "live" as const,
        partial: tabErrors.length > 0,
        errors: tabErrors,
      },
      updatedAt: new Date().toISOString(),
    };

    babyDashboardCache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err: any) {
    console.error("[baby-dashboard] API error:", err.message);
    res.status(500).json({ error: "fetch_failed", message: "Failed to fetch dashboard data" });
  }
});

app.get("/api/baby-dashboard/status", async (_req: Request, res: Response) => {
  const connected = gmail.isConnected();
  let tokenValid = false;
  if (connected) {
    try {
      const token = await gmail.getAccessToken();
      tokenValid = !!token;
    } catch { }
  }
  res.json({
    googleConnected: connected,
    tokenValid,
    cacheAge: babyDashboardCache ? Math.round((Date.now() - babyDashboardCache.timestamp) / 1000) : null,
    reconnectUrl: !tokenValid ? "/api/gmail/auth" : null,
  });
});

app.get("/pages/:slug", async (req: Request, res: Response) => {
  const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!slug) { res.status(400).send("Invalid page slug."); return; }
  const filePath = path.join(PAGES_DIR, `${slug}.html`);
  if (!fs.existsSync(filePath)) {
    res.status(404).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Found</title><style>body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}h1{font-size:1.2rem;color:#888}</style></head><body><h1>Page not found.</h1></body></html>`);
    return;
  }

  const isTokenAuth = !!(req.query.user && req.query.token) || !!req.headers.authorization?.startsWith("Bearer ");
  if (slug === "baby-dashboard" && isTokenAuth && gmail.isConnected()) {
    try {
      let html = fs.readFileSync(filePath, "utf-8");

      let data: any = babyDashboardCache?.data;
      if (!data || Date.now() - (babyDashboardCache?.timestamp || 0) > BABY_CACHE_TTL) {
        const readTab = async (range: string): Promise<string> => {
          try {
            const result = await gws.sheetsRead(BABY_SHEET_ID, range);
            if (result.includes("Error") || result.includes("not connected")) return "";
            return result;
          } catch { return ""; }
        };
        const [timelineResult, apptResult, tasksResult, shoppingResult, namesResult] = await Promise.all([
          readTab("Timeline!A1:F19"), readTab("Appointments!A1:E14"), readTab("To-Do List!A1:F23"),
          readTab("Shopping List!A1:F40"), readTab("Baby Names!A1:F16"),
        ]);
        function parseRows(raw: string): string[][] {
          if (!raw || raw.includes("No data")) return [];
          return raw.split("\n").filter(l => l.startsWith("Row ")).map(l => l.replace(/^Row \d+: /, "").split(" | "));
        }
        const apptRows = parseRows(apptResult);
        const appointments = apptRows.slice(1).filter(r => r[0]).map(r => ({
          title: (r[1] || "").trim(), date: (r[0] || "").trim(), time: "", detail: (r[3] || "").trim(), status: (r[4] || "").trim(),
        }));
        const taskRows = parseRows(tasksResult);
        const tasks = taskRows.slice(1).filter(r => r[0]).map(r => {
          const status = (r[4] || "").trim();
          return { text: (r[0] || "").trim(), priority: "medium", week: parseInt(r[2]) || 0, done: status.includes("✅"), owner: (r[3] || "").trim(), category: (r[1] || "").trim() };
        });
        const shoppingRows = parseRows(shoppingResult);
        const shoppingItems = shoppingRows.slice(1).filter(r => r[1]);
        const shoppingDone = shoppingItems.filter(r => (r[3] || "").includes("✅")).length;
        const tasksDone = tasks.filter(t => t.done).length;
        const timelineRows = parseRows(timelineResult);
        let currentWeekData: any = null;
        timelineRows.slice(1).forEach(r => {
          const status = (r[5] || "").trim();
          if (status.includes("✅") && status.toLowerCase().includes("current")) {
            currentWeekData = { week: parseInt(r[0]) || 0, development: (r[3] || "").trim(), milestone: (r[4] || "").trim() };
          }
        });
        const nameRows = parseRows(namesResult);
        const favNames: any[] = [], otherNames: any[] = [];
        nameRows.slice(1).filter(r => r[0]).forEach(r => {
          const n = (r[0] || "").trim();
          if (n === "⭐ FAVORITES" || n === "📋 SHORTLIST" || !n) return;
          const entry = { name: n, meaning: (r[1] || "").trim() };
          if ((r[3] || "").includes("⭐") || (r[3] || "").includes("🆕") || (r[4] || "").includes("⭐")) favNames.push(entry);
          else otherNames.push(entry);
        });

        const apptJson = JSON.stringify(appointments);
        const tasksJson = JSON.stringify(tasks);
        const checklistJson = JSON.stringify({ shoppingDone: `${shoppingDone}/${shoppingItems.length}`, tasksDone: `${tasksDone}/${tasks.length}` });

        html = html.replace(/<script id="appt-data"[^>]*>.*?<\/script>/s, `<script id="appt-data" type="application/json">${apptJson}</script>`);
        html = html.replace(/<script id="tasks-data"[^>]*>.*?<\/script>/s, `<script id="tasks-data" type="application/json">${tasksJson}</script>`);
        html = html.replace(/<script id="checklist-data"[^>]*>.*?<\/script>/s, `<script id="checklist-data" type="application/json">${checklistJson}</script>`);

        if (currentWeekData) {
          html = html.replace(/id="devNote">[^<]*</s, `id="devNote">${currentWeekData.development}<`);
          html = html.replace(/id="milestoneNote">[^<]*</s, `id="milestoneNote">${currentWeekData.milestone}<`);
        }

        if (favNames.length) {
          const favStr = favNames.map(n => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${n.meaning.replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultFavNames\s*=\s*\[.*?\];/s, `var defaultFavNames = [${favStr}];`);
        }
        if (otherNames.length) {
          const otherStr = otherNames.map(n => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${n.meaning.replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultOtherNames\s*=\s*\[.*?\];/s, `var defaultOtherNames = [${otherStr}];`);
        }
      } else {
        const apptJson = JSON.stringify((data.appointments || []).map((a: any) => ({
          title: a.type || a.title, date: a.date, time: a.time || "", detail: a.notes || a.detail || "", status: a.status || "",
        })));
        const tasksJson = JSON.stringify((data.tasks || []).map((t: any) => ({
          text: t.text, priority: "medium", week: parseInt(t.dueWeek) || 0, done: t.done, owner: t.owner || "", category: t.category || "",
        })));
        const checklistJson = JSON.stringify(data.counters || {});
        html = html.replace(/<script id="appt-data"[^>]*>.*?<\/script>/s, `<script id="appt-data" type="application/json">${apptJson}</script>`);
        html = html.replace(/<script id="tasks-data"[^>]*>.*?<\/script>/s, `<script id="tasks-data" type="application/json">${tasksJson}</script>`);
        html = html.replace(/<script id="checklist-data"[^>]*>.*?<\/script>/s, `<script id="checklist-data" type="application/json">${checklistJson}</script>`);
        if (data.timeline?.currentWeek) {
          html = html.replace(/id="devNote">[^<]*</s, `id="devNote">${data.timeline.currentWeek.development || ""}<`);
          html = html.replace(/id="milestoneNote">[^<]*</s, `id="milestoneNote">${data.timeline.currentWeek.milestone || ""}<`);
        }
        if (data.names?.fav?.length) {
          const favStr = data.names.fav.map((n: any) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${(n.meaning || "").replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultFavNames\s*=\s*\[.*?\];/s, `var defaultFavNames = [${favStr}];`);
        }
        if (data.names?.other?.length) {
          const otherStr = data.names.other.map((n: any) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${(n.meaning || "").replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultOtherNames\s*=\s*\[.*?\];/s, `var defaultOtherNames = [${otherStr}];`);
        }
      }

      res.type("html").send(html);
      return;
    } catch (err) {
      console.error("[baby-dashboard] SSR error:", err);
    }
  }

  res.sendFile(filePath);
});


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
  ...buildWebFetchTools(),
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
  ...buildRealEstateTools(),
  ...buildConversationTools(),
  ...buildWebPublishTools(),
];

{
  const kbToolNames = buildKnowledgeBaseTools().map(t => t.name);
  const staticToolNames = cachedStaticTools.map(t => t.name);
  agentLoader.setRegisteredTools([...kbToolNames, ...staticToolNames]);
}

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
      ...buildAgentTools(() => coreTools, sessionId),
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
      currentToolName: null,
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

      if (event.type === "tool_execution_start") {
        entry.currentToolName = (event as any).toolName || null;
      } else if (event.type === "tool_execution_end") {
        entry.currentToolName = null;
      }

      if (event.type === "agent_end") {
        entry.isAgentRunning = false;
        entry.currentToolName = null;
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
      const lastN = resumedMessages.slice(-20);
      const formatted = lastN.map(m => {
        const role = m.role === "user" ? "RICKIN" : m.role === "agent" ? "YOU" : "SYSTEM";
        const text = m.text.length > 800 ? m.text.slice(0, 800) + "…" : m.text;
        return `${role}: ${text}`;
      }).join("\n\n");
      const resumeContext = `[RESUMED CONVERSATION: "${conv.title}"]\nRickin is picking up exactly where you left off. This is a continuation — treat any references like "it", "that", "this" as referring to the topic below. Here are the last ${lastN.length} messages:\n\n${formatted}\n\nIMPORTANT: When Rickin says something brief like "test it", "try again", "do it", etc., it refers to whatever you were last discussing above. Do NOT start a new unrelated topic.`;
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

  const heartbeat = setInterval(() => { res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`); }, 15_000);
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
    currentToolName: entry.currentToolName,
    messages: entry.conversation.messages,
    pendingCount: entry.pendingMessages.length,
    pendingInterview: entry.pendingInterviewForm || null,
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
  if (entry.modelMode === "max") {
    chosenModelId = MAX_MODEL_ID;
  } else if (hasImages) {
    chosenModelId = FULL_MODEL_ID;
  } else if (entry.modelMode === "fast") {
    chosenModelId = FAST_MODEL_ID;
  } else if (entry.modelMode === "auto") {
    const intent = classifyIntent(text);
    chosenModelId = intent === "fast" ? FAST_MODEL_ID : intent === "max" ? MAX_MODEL_ID : FULL_MODEL_ID;
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
    entry.currentToolName = null;
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
        entry.currentToolName = null;
        processNextPendingMessage(sessionId);
      }).catch(() => {
        console.log(`[prompt] background prompt failed after ${((Date.now() - promptStart) / 1000).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        processNextPendingMessage(sessionId);
      });
    } else {
      entry.isAgentRunning = false;
      entry.currentToolName = null;
    }
  }
});

app.put("/api/session/:id/model-mode", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }
  const { mode } = req.body as { mode?: string };
  if (!mode || !["auto", "fast", "full", "max"].includes(mode)) {
    res.status(400).json({ error: "mode must be auto, fast, full, or max" }); return;
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
    entry.pendingInterviewForm = undefined;
    console.log(`[interview] Received ${responses.length} responses for session ${req.params["id"]}`);
    res.json({ ok: true });
  } else {
    res.status(410).json({ error: "Form expired or already submitted" });
  }
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

app.get("/api/tasks/completed", async (_req: Request, res: Response) => {
  try {
    const completed = await tasks.getCompletedTasks();
    res.json(completed);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/agents/status", (_req: Request, res: Response) => {
  const runningJob = scheduledJobs.getRunningJob();
  const activeSessions: { id: string; running: boolean; tool?: string }[] = [];
  for (const [id, entry] of sessions.entries()) {
    if (entry.isAgentRunning) {
      activeSessions.push({ id, running: true, tool: entry.currentToolName || undefined });
    }
  }
  res.json({
    job: runningJob,
    sessions: activeSessions,
    anyActive: runningJob.running || activeSessions.length > 0,
  });
});

app.get("/api/scheduled-jobs", (_req: Request, res: Response) => {
  res.json(scheduledJobs.getJobs());
});

app.put("/api/scheduled-jobs", (req: Request, res: Response) => {
  try {
    const body = req.body as any;
    if (body.jobs) {
      scheduledJobs.updateConfig({ jobs: body.jobs });
    }
    res.json({ ok: true, jobs: scheduledJobs.getJobs() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put("/api/scheduled-jobs/:id", (req: Request, res: Response) => {
  try {
    const body = req.body as any;
    if (body.schedule) {
      const { hour, minute } = body.schedule;
      if (hour !== undefined && (hour < 0 || hour > 23)) { res.status(400).json({ error: "hour must be 0-23" }); return; }
      if (minute !== undefined && (minute < 0 || minute > 59)) { res.status(400).json({ error: "minute must be 0-59" }); return; }
    }
    if (body.name && body.name.length > 100) { res.status(400).json({ error: "name too long" }); return; }
    if (body.prompt && body.prompt.length > 5000) { res.status(400).json({ error: "prompt too long" }); return; }
    const result = scheduledJobs.updateJob(req.params["id"] as string, body);
    if (!result) { res.status(404).json({ error: "Job not found" }); return; }
    res.json({ ok: true, job: result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/scheduled-jobs", (req: Request, res: Response) => {
  try {
    const { name, agentId, prompt, schedule, enabled } = req.body as any;
    if (!name || !agentId || !prompt) { res.status(400).json({ error: "name, agentId, and prompt required" }); return; }
    if (name.length > 100) { res.status(400).json({ error: "name too long" }); return; }
    if (prompt.length > 5000) { res.status(400).json({ error: "prompt too long" }); return; }
    const sched = schedule || { type: "daily", hour: 8, minute: 0 };
    if (sched.hour < 0 || sched.hour > 23 || sched.minute < 0 || sched.minute > 59) {
      res.status(400).json({ error: "invalid schedule time" }); return;
    }
    const job = scheduledJobs.addJob({ name, agentId, prompt, schedule: sched, enabled: enabled || false });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete("/api/scheduled-jobs/:id", (req: Request, res: Response) => {
  try {
    const removed = scheduledJobs.removeJob(req.params["id"] as string);
    if (!removed) { res.status(404).json({ error: "Job not found" }); return; }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/scheduled-jobs/history", async (_req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(parseInt((_req.query as any).limit) || 20, 100));
    const history = await scheduledJobs.getJobHistory(limit);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/scheduled-jobs/:id/trigger", async (req: Request, res: Response) => {
  try {
    res.json({ ok: true, status: "started" });
    scheduledJobs.triggerJob(req.params["id"] as string).catch(err => {
      console.error(`[scheduled-jobs] Manual trigger failed:`, err);
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.patch("/api/tasks/:id/restore", async (req: Request, res: Response) => {
  try {
    const result = await tasks.restoreTask(req.params["id"] as string);
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
        const feelsMatch = raw.match(/Feels like:\s*([\d.-]+)°C/);
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
          const w: any = { tempC: Math.round(parseFloat(tempMatch[1])), condition, icon };
          if (feelsMatch) w.feelsLikeC = Math.round(parseFloat(feelsMatch[1]));
          const forecastLines = raw.match(/\d{4}-\d{2}-\d{2}:\s*.+/g);
          if (forecastLines) {
            w.forecast = forecastLines.map((line: string) => {
              const m = line.match(/(\d{4}-\d{2}-\d{2}):\s*(.+?),\s*([\d-]+)-([\d-]+)°C.*?Rain:\s*(\d+)%/);
              if (!m) return null;
              return { date: m[1], condition: m[2].trim(), lowC: parseInt(m[3]), highC: parseInt(m[4]), rainPct: parseInt(m[5]) };
            }).filter(Boolean);
          }
          result.weather = w;
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
          const eodTomorrowInTz = new Date(Date.UTC(nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate() + 1, 23, 59, 59, 999));
          const endOfTomorrowUTC = new Date(eodTomorrowInTz.getTime() - tzOffsetMs);
          const events = await calendar.listEventsStructured({ maxResults: 5, timeMax: endOfTomorrowUTC.toISOString() });
          if (events.length > 0) {
            result.nextEvent = events[0];
            result.upcomingEvents = events.slice(0, 5);
          }
        } catch {}
      })());
    }

    promises.push((async () => {
      try {
        const headlines = await news.getTopHeadlines(3);
        if (headlines.length > 0) (result as any).headlines = headlines;
      } catch {}
    })());

    await Promise.all(promises);

    const allJobs = scheduledJobs.getJobs();
    const enabledJobs = allJobs.filter((j: any) => j.enabled);
    const jobItems = enabledJobs.map((j: any) => ({
      name: j.name,
      id: j.id,
      status: j.lastStatus || null,
      lastRun: j.lastRun || null,
    }));
    const okCount = jobItems.filter((j: any) => j.status === "success").length;
    const partialCount = jobItems.filter((j: any) => j.status === "partial").length;
    const failedCount = jobItems.filter((j: any) => j.status === "error").length;
    result.jobs = { total: enabledJobs.length, ok: okCount, partial: partialCount, failed: failedCount, items: jobItems };
    result.nextJob = scheduledJobs.getNextJob();

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

async function gracefulShutdown(signal: string) {
  console.error(`Got ${signal} — closing server...`);
  if (obSyncProcess) {
    try { obSyncProcess.kill(); } catch {}
    obSyncProcess = null;
  }
  scheduledJobs.stopJobSystem();
  const ids = [...sessions.keys()];
  if (ids.length > 0) {
    console.error(`[shutdown] Saving ${ids.length} active session(s)...`);
    const results = await Promise.allSettled(ids.map(id => saveAndCleanSession(id)));
    const saved = results.filter(r => r.status === "fulfilled").length;
    const failed = results.filter(r => r.status === "rejected").length;
    console.error(`[shutdown] Sessions saved: ${saved}, failed: ${failed}`);
  }
  server.close(() => { process.exit(0); });
  setTimeout(() => { process.exit(1); }, 5000);
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
  await scheduledJobs.init();
  console.log("[boot] PostgreSQL ready (shared pool, 4 tables)");

  gmail.checkConnectionStatus().then(status => {
    if (status.connected) console.log(`[boot] Google connected: ${status.email} (Gmail, Calendar, Drive, Sheets)`);
    else console.warn(`[boot] Google not connected: ${status.error}`);
  }).catch(() => {});

  setInterval(async () => {
    try {
      const token = await gmail.getAccessToken();
      if (token) {
        console.log("[google-health] Token valid — auto-refreshed successfully");
      } else {
        console.warn("[google-health] Token refresh failed — Google auth needs reconnection at /api/gmail/auth");
      }
    } catch (err: any) {
      console.error("[google-health] Auth check failed:", err.message);
    }
  }, 6 * 60 * 60 * 1000);

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
          scheduledJobs.startJobSystem(
            async (agentId: string, task: string, onProgress?: (info: { toolName: string; iteration: number }) => void) => {
              const agentTools = [
                ...buildKnowledgeBaseTools(),
                ...cachedStaticTools,
              ];
              const result = await runSubAgent({
                agentId,
                task,
                allTools: agentTools as any,
                apiKey: ANTHROPIC_KEY,
                onProgress,
              });
              return { response: result.response, timedOut: result.timedOut };
            },
            broadcastToAll,
            async (path, content) => {
              try { await kbCreate(path, content); } catch (err) {
                console.error(`[scheduled-jobs] Vault save failed for ${path}:`, err);
              }
            },
            async (path) => kbList(path),
            async (from, to) => kbMove(from, to),
            () => db.getPool(),
          );
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
