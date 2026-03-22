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
import * as coingecko from "./src/coingecko.js";
import { getHistoricalOHLCV } from "./src/coingecko.js";
import { analyzeAsset, recordSignal, loadCryptoSignalParams, invalidateCryptoParamsCache } from "./src/technical-signals.js";
import * as nansen from "./src/nansen.js";
import * as signalSources from "./src/signal-sources.js";
import { runBacktest } from "./src/backtest.js";
import * as cryptoScout from "./src/crypto-scout.js";
import * as polymarket from "./src/polymarket.js";
import * as polymarketScout from "./src/polymarket-scout.js";
import * as bankr from "./src/bankr.js";
import * as maps from "./src/maps.js";
import * as gws from "./src/gws.js";
import * as youtube from "./src/youtube.js";
import * as alerts from "./src/alerts.js";
import * as telegram from "./src/telegram.js";
import * as scheduledJobs from "./src/scheduled-jobs.js";
import * as agentLoader from "./src/agents/loader.js";
import { runSubAgent } from "./src/agents/orchestrator.js";
import { extractAndFileInsights } from "./src/memory-extractor.js";
import * as obsidianSkills from "./src/obsidian-skills.js";
import { cleanHtmlToMarkdown, looksLikeHtml } from "./src/defuddle.js";
import * as vaultGraph from "./src/vault-graph.js";
import * as hindsight from "./src/hindsight.js";
import * as oversight from "./src/oversight.js";
import * as autoresearch from "./src/autoresearch.js";

const PORT = parseInt(process.env.PORT || "5000", 10);
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
obsidianSkills.loadAllSkills().catch(err => console.warn("[startup] Failed to preload Obsidian skills:", err));

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

vaultGraph.init({
  read: kbRead,
  list: kbList,
  listRecursive: kbListRecursive,
  append: kbAppend,
});

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
          let content = params.content;
          if (looksLikeHtml(content)) {
            const cleaned = cleanHtmlToMarkdown(content);
            if (cleaned.length > 0) {
              console.log(`[vault] defuddle: cleaned HTML (${content.length} → ${cleaned.length} chars)`);
              content = cleaned;
            }
          }
          const result = await kbCreate(params.path, content);
          console.log(`[vault] notes_create OK: ${params.path} (${content.length} chars)`);
          try {
            const linkResult = await vaultGraph.addBidirectionalLinks(params.path, content);
            if (linkResult.linkedTo.length > 0) {
              console.log(`[vault-graph] auto-linked ${params.path} to ${linkResult.linkedTo.length} related notes`);
            }
          } catch (linkErr: any) {
            console.warn(`[vault-graph] bidirectional linking failed (non-fatal): ${linkErr.message}`);
          }
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
    {
      name: "notes_graph_context",
      label: "Notes Graph Context",
      description: "Follow [[wikilinks]] in a note to gather related context. Reads the starting note, extracts all wikilinks, and recursively follows them (breadth-first) up to the specified depth. Returns the combined content of all linked notes. Use this when investigating a vault topic to automatically pull in connected knowledge.",
      parameters: Type.Object({
        path: Type.String({ description: "Starting note path (e.g. 'Projects/Research.md')" }),
        depth: Type.Optional(Type.Number({ description: "Max link-following depth (default 2, max 3)" })),
        token_budget: Type.Optional(Type.Number({ description: "Max estimated tokens to return (default 30000)" })),
      }),
      async execute(_toolCallId, params: { path: string; depth?: number; token_budget?: number }) {
        try {
          const depth = Math.min(Math.max(params.depth ?? 2, 1), 3);
          const budget = Math.min(Math.max(params.token_budget ?? 30000, 1000), 60000);
          const result = await vaultGraph.graphContext(params.path, depth, budget);
          const output = result.notes.map(n =>
            `--- ${n.path} (depth ${n.depth}) ---\n${n.content}`
          ).join("\n\n");
          const summary = `Graph traversal from "${params.path}": ${result.notes.length} notes, ~${result.totalTokens} tokens${result.truncated ? " (truncated by budget)" : ""}`;
          console.log(`[vault] notes_graph_context OK: ${summary}`);
          return { content: [{ type: "text" as const, text: `${summary}\n\n${output}` }], details: {} };
        } catch (err: any) {
          console.error(`[vault] notes_graph_context FAILED: ${params.path} — ${err.message}`);
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

function buildImageTools(): ToolDefinition[] {
  if (!ANTHROPIC_KEY) return [];
  return [
    {
      name: "describe_image",
      label: "Describe Image",
      description:
        "Fetch an image from a URL and describe its visual content using a vision model. Use when you need to 'see' an image, verify how a web page looks, check a chart/graph, or describe a photo. Supports JPEG, PNG, WebP, GIF. Returns a detailed text description of what the image contains.",
      parameters: Type.Object({
        url: Type.String({ description: "The URL of the image to describe (must be a direct image URL ending in .jpg, .png, .webp, .gif, or a URL that returns an image content type)" }),
        question: Type.Optional(Type.String({ description: "Optional specific question about the image, e.g. 'What text is visible?' or 'Are the appointments showing correctly?'" })),
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;

          const imgRes = await fetch(url, {
            headers: { "User-Agent": "DarkNode/1.0" },
            signal: AbortSignal.timeout(15000),
          });
          if (!imgRes.ok) return { content: [{ type: "text" as const, text: `Failed to fetch image: HTTP ${imgRes.status}` }], details: { error: `HTTP ${imgRes.status}` } };

          const contentType = imgRes.headers.get("content-type") || "";
          const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
          const mediaType = validTypes.find(t => contentType.includes(t.split("/")[1])) || "image/jpeg";

          const buffer = Buffer.from(await imgRes.arrayBuffer());
          if (buffer.length > 20 * 1024 * 1024) return { content: [{ type: "text" as const, text: "Image too large (>20MB)" }], details: { error: "too_large" } };

          const base64 = buffer.toString("base64");
          const prompt = params.question
            ? `Describe this image in detail, then answer this specific question: ${params.question}`
            : "Describe this image in detail. Include all visible text, layout, colors, and any notable elements.";

          const { default: Anthropic } = await import("@anthropic-ai/sdk");
          const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
          const response = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1500,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType as any, data: base64 } },
                { type: "text", text: prompt },
              ],
            }],
          });

          const description = response.content.map((b: any) => b.type === "text" ? b.text : "").join("");
          return {
            content: [{ type: "text" as const, text: `**Image Description** (${url})\n\n${description}` }],
            details: { size: buffer.length, contentType: mediaType },
          };
        } catch (err: any) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `Failed to describe image: ${msg}` }], details: { error: msg } };
        }
      },
    },
  ];
}

function buildRenderPageTools(): ToolDefinition[] {
  const bbKey = process.env.BROWSERBASE_API_KEY;
  const lightpandaBin = path.join(PROJECT_ROOT, ".bin/lightpanda");
  const hasLightpanda = fs.existsSync(lightpandaBin);
  if (!bbKey && !hasLightpanda) return [];

  function isBlockedUrl(url: string): boolean {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return true;
      if (host.startsWith("192.168.") || host.startsWith("10.") || host.startsWith("172.")) return true;
      if (host === "metadata.google.internal" || host.startsWith("169.254.")) return true;
      return false;
    } catch { return true; }
  }

  async function renderWithBrowserbase(url: string): Promise<string> {
    const puppeteer = (await import("puppeteer-core")).default;
    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://connect.browserbase.com?apiKey=${bbKey}`,
    });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      const title = await page.title();
      const text = await page.evaluate(() => {
        const el = document.querySelector("article") || document.querySelector("main") || document.body;
        return el?.innerText || "";
      });
      return `# ${title}\n\n${text}`;
    } finally {
      await browser.close();
    }
  }

  async function renderWithLightpanda(url: string, fmt: string): Promise<string> {
    const { execFile } = await import("child_process");
    return new Promise<string>((resolve, reject) => {
      execFile(lightpandaBin, ["fetch", "--dump", fmt, "--http_timeout", "15000", url], { timeout: 20000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }

  const tools: ToolDefinition[] = [
    {
      name: "render_page",
      label: "Render Page",
      description:
        "Render a web page in a cloud browser (Browserbase) and return the fully rendered content. Unlike web_fetch which returns raw HTML, this tool executes JavaScript in a real Chrome browser with anti-bot protection, and returns the page as a human would see it — with all dynamic content loaded, JS-rendered elements visible, and anti-scraping measures bypassed. Use this when web_fetch returns empty/incomplete content, for JS-heavy pages, paywalled sites, or any page that blocks scrapers. For authenticated pages on rickin.live, include the appropriate auth query parameters.",
      parameters: Type.Object({
        url: Type.String({ description: "The full URL to render (must start with http:// or https://)" }),
        format: Type.Optional(Type.String({ description: "Output format: 'markdown' (default) or 'html'" })),
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;
          if (isBlockedUrl(url)) return { content: [{ type: "text" as const, text: "Blocked: cannot render internal/private URLs" }], details: { error: "blocked" } };
          const fmt = params.format === "html" ? "html" : "markdown";

          let result: string;
          if (bbKey) {
            try {
              console.log(`[render_page] Using Browserbase for ${url}`);
              result = await renderWithBrowserbase(url);
            } catch (bbErr: any) {
              if (hasLightpanda) {
                console.log(`[render_page] Browserbase failed (${bbErr.message}), falling back to Lightpanda for ${url}`);
                result = await renderWithLightpanda(url, fmt);
              } else {
                throw bbErr;
              }
            }
          } else {
            console.log(`[render_page] Using Lightpanda fallback for ${url}`);
            result = await renderWithLightpanda(url, fmt);
          }

          const truncated = result.length > 80000;
          const content = truncated ? result.slice(0, 80000) + "\n\n[TRUNCATED — content too long]" : result;

          return {
            content: [{ type: "text" as const, text: `**Rendered Page** (${fmt}) — ${url}\n\n${content}` }],
            details: { format: fmt, length: result.length, truncated },
          };
        } catch (err: any) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `Failed to render page: ${msg}` }], details: { error: msg } };
        }
      },
    },
  ];

  if (bbKey) {
    tools.push({
      name: "browse_page",
      label: "Browse Page",
      description:
        "Interactive cloud browser session powered by Browserbase. Unlike render_page which just captures the page content, this tool can interact with the page — click buttons, fill forms, wait for elements, handle cookie consent, navigate pagination, and extract targeted data. Use for: sites with cookie/consent walls, paginated results, content behind login forms, or when you need to click through to specific sections. Returns the extracted text content after all actions are performed.",
      parameters: Type.Object({
        url: Type.String({ description: "The URL to navigate to" }),
        actions: Type.Optional(Type.Array(Type.Object({
          type: Type.String({ description: "Action type: 'click', 'type', 'wait', 'scroll', 'extract', 'screenshot'" }),
          selector: Type.Optional(Type.String({ description: "CSS selector for the target element" })),
          value: Type.Optional(Type.String({ description: "Value to type (for 'type' action) or attribute to extract" })),
          timeout: Type.Optional(Type.Number({ description: "Timeout in ms for wait actions (default 5000)" })),
        }), { description: "Ordered list of actions to perform on the page" })),
        extract_selector: Type.Optional(Type.String({ description: "CSS selector to extract text from after actions (default: article || main || body)" })),
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;
          if (isBlockedUrl(url)) return { content: [{ type: "text" as const, text: "Blocked: cannot browse internal/private URLs" }], details: { error: "blocked" } };
          console.log(`[browse_page] Starting Browserbase session for ${url}`);

          const puppeteer = (await import("puppeteer-core")).default;
          const browser = await puppeteer.connect({
            browserWSEndpoint: `wss://connect.browserbase.com?apiKey=${bbKey}`,
          });

          try {
            const page = await browser.newPage();
            await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

            const actionResults: string[] = [];
            if (params.actions) {
              for (const action of params.actions) {
                try {
                  switch (action.type) {
                    case "click":
                      if (action.selector) {
                        await page.waitForSelector(action.selector, { timeout: action.timeout || 5000 });
                        await page.click(action.selector);
                        actionResults.push(`Clicked: ${action.selector}`);
                        await new Promise(r => setTimeout(r, 1000));
                      }
                      break;
                    case "type":
                      if (action.selector && action.value) {
                        await page.waitForSelector(action.selector, { timeout: action.timeout || 5000 });
                        await page.type(action.selector, action.value);
                        actionResults.push(`Typed into: ${action.selector}`);
                      }
                      break;
                    case "wait":
                      if (action.selector) {
                        await page.waitForSelector(action.selector, { timeout: action.timeout || 10000 });
                        actionResults.push(`Found: ${action.selector}`);
                      } else {
                        await new Promise(r => setTimeout(r, action.timeout || 2000));
                        actionResults.push(`Waited ${action.timeout || 2000}ms`);
                      }
                      break;
                    case "scroll":
                      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                      actionResults.push("Scrolled down");
                      await new Promise(r => setTimeout(r, 1000));
                      break;
                    case "extract":
                      if (action.selector) {
                        const extracted = await page.evaluate((sel: string) => {
                          const els = document.querySelectorAll(sel);
                          return Array.from(els).map(el => el.textContent?.trim()).filter(Boolean).join("\n");
                        }, action.selector);
                        actionResults.push(`Extracted from ${action.selector}:\n${extracted}`);
                      }
                      break;
                    case "screenshot":
                      actionResults.push("Screenshot captured (browser session)");
                      break;
                  }
                } catch (actionErr: any) {
                  actionResults.push(`Action failed (${action.type} ${action.selector || ""}): ${actionErr.message}`);
                }
              }
            }

            const extractSel = params.extract_selector || "article, main, body";
            const title = await page.title();
            const mainContent = await page.evaluate((sel: string) => {
              const el = document.querySelector(sel) || document.body;
              return el?.innerText || "";
            }, extractSel);

            await browser.close();

            const actionsLog = actionResults.length > 0 ? `\n**Actions performed:**\n${actionResults.map(a => `- ${a}`).join("\n")}\n` : "";
            const fullContent = `# ${title}\n${actionsLog}\n${mainContent}`;
            const truncated = fullContent.length > 80000;
            const content = truncated ? fullContent.slice(0, 80000) + "\n\n[TRUNCATED]" : fullContent;

            return {
              content: [{ type: "text" as const, text: `**Browsed Page** — ${url}\n\n${content}` }],
              details: { actionsPerformed: actionResults.length, length: fullContent.length, truncated },
            };
          } catch (innerErr) {
            await browser.close();
            throw innerErr;
          }
        } catch (err: any) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `Failed to browse page: ${msg}` }], details: { error: msg } };
        }
      },
    });
  }

  return tools;
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

function buildSignalSourceTools(): ToolDefinition[] {
  return [
    {
      name: "fear_greed_index",
      label: "Fear & Greed Index",
      description: "Get the current Crypto Fear & Greed Index (0-100). Returns value, classification (Extreme Fear/Fear/Neutral/Greed/Extreme Greed), regime signal, and previous day comparison. Use for market regime filtering.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await signalSources.getFearGreedIndex();
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "binance_signals",
      label: "Binance Multi-TF Signals",
      description: "Get multi-timeframe (1h/4h/1d) technical signals for a crypto pair from Binance. Returns RSI, MACD, SMA crossovers, volume ratios, and composite bull/bear score per timeframe. Use for additional confirmation alongside the Nunchi voting ensemble.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Trading pair symbol (e.g. 'BTC', 'BTCUSDT', 'ETH', 'SOL')" }),
      }),
      async execute(_toolCallId: string, params: { symbol: string }) {
        try {
          const result = await signalSources.getBinanceSignals(params.symbol);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "binance_watchlist_scan",
      label: "Binance Watchlist Scanner",
      description: "Scan multiple crypto symbols at once using Binance multi-timeframe analysis. Returns scored signals ranked by strength. Use to quickly screen the watchlist for strongest setups.",
      parameters: Type.Object({
        symbols: Type.Array(Type.String(), { description: "Array of symbols to scan (e.g. ['BTC', 'ETH', 'SOL', 'BNKR'])" }),
      }),
      async execute(_toolCallId: string, params: { symbols: string[] }) {
        try {
          const result = await signalSources.scanBinanceWatchlist(params.symbols);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "crypto_liquidations",
      label: "Crypto Liquidations",
      description: "Get 24h crypto liquidation data. Returns total liquidations, long vs short breakdown, and regime signal (LONG_SQUEEZE, SHORT_SQUEEZE, BALANCED). Use for detecting leverage cascade risk.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await signalSources.getCryptoLiquidations();
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "crypto_sentiment",
      label: "Crypto Sentiment",
      description: "Get aggregated social sentiment for a crypto asset. Returns overall sentiment (BULLISH/BEARISH/NEUTRAL), score, and source breakdown. Use for confirming thesis direction.",
      parameters: Type.Object({
        query: Type.String({ description: "Crypto asset name or ticker (e.g. 'bitcoin', 'BTC', 'ethereum')" }),
      }),
      async execute(_toolCallId: string, params: { query: string }) {
        try {
          const result = await signalSources.getCryptoSentiment(params.query);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "defillama_tvl",
      label: "DefiLlama TVL Data",
      description: "Get DeFi protocol TVL data from DefiLlama. Returns top protocols by TVL, chain TVL breakdown. Optionally filter by specific protocol. Use for identifying DeFi capital flows.",
      parameters: Type.Object({
        protocol: Type.Optional(Type.String({ description: "Specific protocol slug (e.g. 'aave', 'uniswap'). Omit for global overview." })),
      }),
      async execute(_toolCallId: string, params: { protocol?: string }) {
        try {
          const result = await signalSources.getDefiLlamaData(params.protocol);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "defillama_yields",
      label: "DefiLlama Top Yields",
      description: "Get top DeFi yield pools from DefiLlama. Returns pools sorted by TVL with APY breakdown (base + reward), project, chain. Use for identifying yield opportunities and DeFi momentum.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await signalSources.getDefiLlamaYields();
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "binance_funding_rates",
      label: "Binance Funding Rates",
      description: "Get current perpetual futures funding rates from Binance. Returns rates per symbol with signals (OVERLEVERAGED_LONGS/SHORTS/NEUTRAL). Extreme funding rates indicate crowded positioning. Optionally filter by symbols.",
      parameters: Type.Object({
        symbols: Type.Optional(Type.Array(Type.String(), { description: "Filter by specific symbols (e.g. ['BTC', 'ETH']). Omit for top 30." })),
      }),
      async execute(_toolCallId: string, params: { symbols?: string[] }) {
        try {
          const result = await signalSources.getBinanceFundingRates(params.symbols);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "open_interest",
      label: "Open Interest & Positioning",
      description: "Get open interest, funding rate, and long/short ratio for a futures pair on Binance. Returns positioning signal (CROWDED_LONG, CROWDED_SHORT, etc). Use for detecting overcrowded trades.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Futures pair (e.g. 'BTC', 'BTCUSDT', 'ETH')" }),
      }),
      async execute(_toolCallId: string, params: { symbol: string }) {
        try {
          const result = await signalSources.getOpenInterestHistory(params.symbol);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "enhanced_coingecko",
      label: "Enhanced CoinGecko Intelligence",
      description: "Get enhanced CoinGecko data: trending tokens, top DeFi by mcap/TVL ratio, BTC/ETH dominance breakdown. Use for sector rotation and trend analysis.",
      parameters: Type.Object({
        category: Type.Optional(Type.String({ description: "Optional category filter" })),
      }),
      async execute(_toolCallId: string, params: { category?: string }) {
        try {
          const result = await signalSources.getEnhancedCoinGeckoData(params.category);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
  ];
}

function buildCoinGeckoTools(): ToolDefinition[] {
  return [
    {
      name: "crypto_trending",
      label: "Crypto Trending",
      description: "Get trending cryptocurrencies and categories on CoinGecko. Returns structured JSON with coins (name, symbol, rank, price, 24h change) and trending categories.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await coingecko.getTrending();
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "crypto_movers",
      label: "Crypto Movers",
      description: "Get top crypto gainers or losers by 24h price change. Returns structured JSON with direction and coins array (name, symbol, price, 24h/7d change, market cap).",
      parameters: Type.Object({
        direction: Type.Optional(Type.Union([Type.Literal("gainers"), Type.Literal("losers")], { description: "Show top gainers or losers. Default: gainers", default: "gainers" })),
        limit: Type.Optional(Type.Number({ description: "Number of results (max 50). Default: 20", default: 20 })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const result = await coingecko.getMovers(params.direction || "gainers", Math.min(params.limit || 20, 50));
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "crypto_categories",
      label: "Crypto Categories",
      description: "Get crypto market categories sorted by 24h market cap change. Returns structured JSON with categories array (name, 24h change, market cap, volume). Useful for sector analysis.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Number of categories (max 50). Default: 20", default: 20 })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const result = await coingecko.getCategories(Math.min(params.limit || 20, 50));
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "crypto_market_overview",
      label: "Crypto Market Overview",
      description: "Get global crypto market overview. Returns structured JSON: total market cap, 24h volume, BTC/ETH dominance, active cryptocurrencies, and 24h market cap change.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await coingecko.getMarketOverview();
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "crypto_historical",
      label: "Crypto Historical Data",
      description: "Get historical price data summary for a cryptocurrency. Returns structured JSON: coin_id, days, candle_count, period dates, current price, high/low, return %. Data cached hourly.",
      parameters: Type.Object({
        coin: Type.String({ description: "Cryptocurrency name or ticker (e.g. 'bitcoin', 'BTC', 'ethereum')" }),
        days: Type.Optional(Type.Number({ description: "Number of days of history (max 90). Default: 90", default: 90 })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const result = await coingecko.getHistoricalOHLCVFormatted(params.coin, Math.min(params.days || 90, 90));
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "technical_analysis",
      label: "Technical Analysis",
      description: "Run technical analysis on a cryptocurrency using the 6-signal Nunchi voting ensemble. Returns structured JSON: technical_score (0.0-1.0), regime (TRENDING/RANGING/VOLATILE), ATR stop loss, per-signal breakdown, vote counts, BTC confirmation filter (for alt coins). Uses cached hourly OHLCV. Parameters are UNVALIDATED starting points.",
      parameters: Type.Object({
        coin: Type.String({ description: "Cryptocurrency name or ticker (e.g. 'bitcoin', 'BTC', 'BNKR', 'VIRTUAL')" }),
        days: Type.Optional(Type.Number({ description: "Days of data to analyze (max 90). Default: 90", default: 90 })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const candles = await getHistoricalOHLCV(params.coin, Math.min(params.days || 90, 90));
          if (candles.length === 0) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No historical data available for "${params.coin}"` }) }], details: {} };
          }
          const coinLower = (params.coin || "").toLowerCase();
          const isBTC = coinLower === "bitcoin" || coinLower === "btc";
          let btcCandles: any[] | undefined;
          if (!isBTC) {
            try {
              btcCandles = await getHistoricalOHLCV("bitcoin", Math.min(params.days || 90, 90));
            } catch {}
          }
          const dbParams = await loadCryptoSignalParams();
          const result = analyzeAsset(candles, dbParams, btcCandles, coinLower);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "crypto_backtest",
      label: "Crypto Backtest",
      description: "Run a backtest of the 6-signal voting ensemble on historical OHLCV data. Returns Sharpe ratio, win rate, max drawdown, Nunchi composite score, and trade log.",
      parameters: Type.Object({
        coin: Type.String({ description: "Cryptocurrency name or ticker (e.g. 'bitcoin', 'BTC')" }),
        days: Type.Optional(Type.Number({ description: "Days of data to backtest (max 90). Default: 30", default: 30 })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const candles = await getHistoricalOHLCV(params.coin, Math.min(params.days || 30, 90));
          if (candles.length === 0) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No historical data for "${params.coin}"` }) }], details: {} };
          }
          const result = runBacktest(candles, params.coin);
          const { trades, ...summary } = result;
          return { content: [{ type: "text" as const, text: JSON.stringify({ ...summary, recent_trades: trades.slice(-10) }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "nansen_smart_money",
      label: "Nansen Smart Money",
      description: "Get smart money wallet flow data for a token from Nansen. Shows net flow direction, inflow/outflow amounts, and number of smart money wallets buying vs selling.",
      parameters: Type.Object({
        token: Type.String({ description: "Token symbol or name (e.g. 'ethereum', 'bitcoin')" }),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const result = await nansen.getSmartMoneyFlow(params.token);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "nansen_token_holders",
      label: "Nansen Token Holders",
      description: "Get token holder distribution data from Nansen. Shows total holders, whale concentration, 24h holder change, and whale activity (accumulating/distributing/stable).",
      parameters: Type.Object({
        token: Type.String({ description: "Token symbol or name (e.g. 'ethereum', 'bitcoin')" }),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const result = await nansen.getTokenHolders(params.token);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "nansen_hot_contracts",
      label: "Nansen Hot Contracts",
      description: "Get trending smart contracts from Nansen. Shows contracts with highest smart money interaction counts, useful for identifying emerging DeFi activity.",
      parameters: Type.Object({
        chain: Type.Optional(Type.String({ description: "Blockchain to query (default: ethereum). Options: ethereum, base, solana", default: "ethereum" })),
        limit: Type.Optional(Type.Number({ description: "Number of contracts to return (default: 10)", default: 10 })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const result = await nansen.getHotContracts(params.chain || "ethereum", params.limit || 10);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "signal_quality",
      label: "Signal Quality Scores",
      description: "Get signal quality scores — historical win rates by source (crypto_scout, polymarket_scout) and asset class. Shows rolling win rate, avg P&L, total wins/losses, and recent trade results. Use this before generating theses to understand which signal sources are performing well. Sources with >60% win rate deserve a confidence boost, <40% deserve a penalty.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const scores = await bankr.getSignalQuality();
          const summary = scores.map(s => ({
            source: s.source,
            asset_class: s.asset_class,
            win_rate: s.win_rate,
            wins: s.wins,
            losses: s.losses,
            total_pnl: s.total_pnl,
            avg_pnl: s.avg_pnl,
            sample_size: s.recent_results.length,
            modifier: bankr.getSignalQualityModifier(scores, s.source, s.asset_class).modifier,
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify({ scores: summary }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "scout_theses",
      label: "SCOUT Active Theses",
      description: "Get all active CRYPTO SCOUT trading theses. Returns structured thesis data including vote counts, technical scores, entry/stop/target prices, and confidence levels.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const theses = await cryptoScout.getActiveTheses();
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: theses.length, theses }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "scout_watchlist",
      label: "SCOUT Watchlist",
      description: "Get the current SCOUT watchlist — the list of CoinGecko IDs that the micro-scan monitors every 30 minutes.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const watchlist = await cryptoScout.getWatchlist();
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: watchlist.length, assets: watchlist }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "save_thesis",
      label: "Save SCOUT Thesis",
      description: "Persist a trading thesis to the database. Required fields: asset, asset_id (CoinGecko ID), direction (LONG/SHORT), confidence (HIGH/MEDIUM/LOW), technical_score, vote_count (e.g. '5/6'), market_regime, entry_price, exit_price (target), stop_price, atr_value, sources (array), reasoning. Optional: backtest_score, nansen_flow_direction, time_horizon.",
      parameters: Type.Object({
        asset: Type.String({ description: "Asset display name (e.g. 'Bitcoin')" }),
        asset_id: Type.String({ description: "CoinGecko ID (e.g. 'bitcoin')" }),
        direction: Type.Union([Type.Literal("LONG"), Type.Literal("SHORT")]),
        confidence: Type.Union([Type.Literal("HIGH"), Type.Literal("MEDIUM"), Type.Literal("LOW")]),
        technical_score: Type.Number(),
        vote_count: Type.String({ description: "Vote count string e.g. '5/6'" }),
        market_regime: Type.String(),
        entry_price: Type.Number(),
        exit_price: Type.Number({ description: "Target/take-profit price" }),
        stop_price: Type.Number(),
        atr_value: Type.Number(),
        sources: Type.Array(Type.String()),
        reasoning: Type.String(),
        backtest_score: Type.Optional(Type.Number()),
        nansen_flow_direction: Type.Optional(Type.String()),
        time_horizon: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const thesis = cryptoScout.buildThesis({
            asset: params.asset,
            asset_id: params.asset_id,
            direction: params.direction,
            confidence: params.confidence,
            technical_score: params.technical_score,
            vote_count: params.vote_count,
            market_regime: params.market_regime,
            entry_price: params.entry_price,
            exit_price: params.exit_price,
            stop_price: params.stop_price,
            atr_value: params.atr_value,
            sources: params.sources,
            reasoning: params.reasoning,
            backtest_score: params.backtest_score,
            nansen_flow_direction: params.nansen_flow_direction,
            time_horizon: params.time_horizon,
          });
          await cryptoScout.saveTheses([thesis]);
          recordSignal(params.asset_id, "entry");
          return { content: [{ type: "text" as const, text: JSON.stringify({ saved: true, thesis_id: thesis.id, expires_at: new Date(thesis.expires_at).toISOString() }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "update_watchlist",
      label: "Update SCOUT Watchlist",
      description: "Update the SCOUT watchlist with a list of CoinGecko IDs. Default assets (BTC, ETH, SOL, BNKR) are always included.",
      parameters: Type.Object({
        assets: Type.Array(Type.String(), { description: "Array of CoinGecko IDs to watch (e.g. ['bitcoin', 'ethereum', 'solana', 'virtual-protocol'])" }),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          await cryptoScout.updateWatchlist(params.assets);
          const updated = await cryptoScout.getWatchlist();
          return { content: [{ type: "text" as const, text: JSON.stringify({ updated: true, count: updated.length, assets: updated }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "retire_thesis",
      label: "Retire SCOUT Thesis",
      description: "Retire (deactivate) a SCOUT thesis by its ID. Used when a thesis is no longer valid or has been executed.",
      parameters: Type.Object({
        thesis_id: Type.String({ description: "The thesis ID to retire" }),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          await cryptoScout.retireThesis(params.thesis_id);
          return { content: [{ type: "text" as const, text: JSON.stringify({ retired: true, thesis_id: params.thesis_id }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "polymarket_search",
      label: "Polymarket Search",
      description: "Search Polymarket for prediction markets by topic/tag. Returns markets with odds, volume, liquidity, and end dates.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Topic or tag to search (e.g. 'crypto', 'politics', 'sports')" })),
        limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const result = params.query
            ? await polymarket.searchMarkets(params.query, params.limit || 20)
            : await polymarket.getTrendingMarkets(params.limit || 20);
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: result.length, markets: result }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "polymarket_trending",
      label: "Polymarket Trending",
      description: "Get trending Polymarket prediction markets sorted by 24h volume.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const result = await polymarket.getTrendingMarkets(params.limit || 20);
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: result.length, markets: result }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "polymarket_details",
      label: "Polymarket Market Details",
      description: "Get detailed info for a specific Polymarket market by condition ID.",
      parameters: Type.Object({
        condition_id: Type.String({ description: "Polymarket condition/market ID" }),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const result = await polymarket.getMarketDetails(params.condition_id);
          return { content: [{ type: "text" as const, text: JSON.stringify(result || { error: "Market not found" }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "polymarket_whale_watchlist",
      label: "Polymarket Whale Watchlist",
      description: "Get the current whale watchlist for Polymarket tracking. Shows tracked wallets with composite scores, win rates, ROI.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const wallets = await polymarket.getWhaleWatchlist();
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: wallets.length, wallets }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "polymarket_whale_activity",
      label: "Polymarket Whale Activity",
      description: "Get recent whale activity (last 24h) from tracked Polymarket wallets.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const activities = await polymarket.getWhaleActivities();
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: activities.length, activities }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "polymarket_consensus",
      label: "Polymarket Whale Consensus",
      description: "Detect whale consensus — markets where multiple tracked whales are positioned in the same direction.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const activities = await polymarket.getWhaleActivities();
          const consensus = await polymarket.detectConsensus(activities);
          return { content: [{ type: "text" as const, text: JSON.stringify({ consensus_count: consensus.length, consensus }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "polymarket_theses",
      label: "Polymarket Active Theses",
      description: "Get all active Polymarket SCOUT trading theses.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const theses = await polymarketScout.getActiveTheses();
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: theses.length, theses }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "save_pm_thesis",
      label: "Save Polymarket Thesis",
      description: "Persist a Polymarket trading thesis. Requires: condition_id, direction (YES/NO), confidence, whale data, reasoning.",
      parameters: Type.Object({
        condition_id: Type.String({ description: "Polymarket market condition ID" }),
        direction: Type.Union([Type.Literal("YES"), Type.Literal("NO")]),
        confidence: Type.Union([Type.Literal("HIGH"), Type.Literal("MEDIUM"), Type.Literal("LOW"), Type.Literal("SPECULATIVE")]),
        whale_wallets: Type.Array(Type.String(), { description: "Wallet addresses in consensus (empty array OK for LOW volume-weighted fallback)" }),
        whale_avg_score: Type.Number(),
        total_whale_amount: Type.Number(),
        reasoning: Type.String(),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const market = await polymarket.getMarketDetails(params.condition_id);
          if (!market) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Market not found" }) }], details: {} };

          const yesPrice = market.tokens.find((t: any) => t.outcome === "Yes")?.price || 0;
          const noPrice = market.tokens.find((t: any) => t.outcome === "No")?.price || 0;
          const odds = params.direction === "YES" ? yesPrice : noPrice;
          const hoursToResolution = market.end_date_iso ? (new Date(market.end_date_iso).getTime() - Date.now()) / (60 * 60 * 1000) : 9999;

          const thresholdResult = await polymarketScout.meetsThesisThresholds({
            whale_score: params.whale_avg_score,
            whale_consensus: params.whale_wallets.length,
            market_volume: market.volume,
            market_liquidity: market.liquidity,
            odds,
            hours_to_resolution: hoursToResolution,
          });
          console.log(`[pm-scout] save_pm_thesis: ${market.question?.slice(0, 50)} — threshold ${thresholdResult.meets ? "PASS" : "REJECT"} (tier=${thresholdResult.tier || "none"}, agent_confidence=${params.confidence})`);

          if (!thresholdResult.meets) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ saved: false, rejected: true, failures: thresholdResult.failures }) }], details: {} };
          }

          const resolvedConfidence = thresholdResult.tier || params.confidence;

          const thesis = polymarketScout.buildThesis({
            market,
            direction: params.direction,
            confidence: resolvedConfidence,
            whale_consensus: params.whale_wallets.length,
            whale_wallets: params.whale_wallets,
            whale_avg_score: params.whale_avg_score,
            total_whale_amount: params.total_whale_amount,
            sources: ["polymarket_clob", "whale_tracker"],
            reasoning: params.reasoning,
          });
          await polymarketScout.saveTheses([thesis]);
          return { content: [{ type: "text" as const, text: JSON.stringify({ saved: true, thesis_id: thesis.id, threshold: thresholdResult }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "retire_pm_thesis",
      label: "Retire Polymarket Thesis",
      description: "Retire a Polymarket thesis by its ID.",
      parameters: Type.Object({
        thesis_id: Type.String({ description: "The PM thesis ID to retire" }),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          await polymarketScout.retireThesis(params.thesis_id);
          return { content: [{ type: "text" as const, text: JSON.stringify({ retired: true, thesis_id: params.thesis_id }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "bankr_risk_check",
      label: "BANKR Pre-Trade Risk Check",
      description: "Run pre-execution risk checks before a trade. Returns pass/fail for each check: kill switch, pause, leverage, margin, position limits, exposure, correlation.",
      parameters: Type.Object({
        asset: Type.String({ description: "Asset name" }),
        asset_class: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")]),
        direction: Type.String({ description: "LONG, SHORT, YES, or NO" }),
        leverage: Type.Number({ description: "Leverage multiplier (max 2)" }),
        entry_price: Type.Number(),
        stop_price: Type.Number(),
        confidence: Type.Optional(Type.Number({ description: "Confidence score 1-5 for tiered approval" })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const result = await bankr.runPreExecutionChecks(params);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "bankr_open_position",
      label: "BANKR Open Position",
      description: "Open a new position. Runs risk checks with tiered approval (autonomous/dead_zone/human_required), calculates position size (5% risk), executes via BNKR only.",
      parameters: Type.Object({
        thesis_id: Type.String(),
        asset: Type.String(),
        asset_class: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")]),
        source: Type.Optional(Type.Union([Type.Literal("crypto_scout"), Type.Literal("polymarket_scout"), Type.Literal("manual")])),
        direction: Type.String(),
        leverage: Type.Number(),
        entry_price: Type.Number(),
        stop_price: Type.Number(),
        atr_value: Type.Number(),
        venue: Type.Literal("bnkr"),
        confidence: Type.Optional(Type.Number({ description: "Confidence score 1-5 for tiered approval" })),
        market_id: Type.Optional(Type.String({ description: "Polymarket market ID for BNKR execution" })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const riskCheck = await bankr.runPreExecutionChecks({
            asset: params.asset,
            asset_class: params.asset_class,
            direction: params.direction,
            leverage: params.leverage,
            entry_price: params.entry_price,
            stop_price: params.stop_price,
            confidence: params.confidence,
          });
          if (!riskCheck.passed) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ executed: false, tier: riskCheck.tier, reason: riskCheck.rejection_reason, checks: riskCheck.checks }) }], details: {} };
          }
          const mode = await bankr.getMode();
          if (mode === "SHADOW") {
            return { content: [{ type: "text" as const, text: JSON.stringify({ executed: false, tier: riskCheck.tier, reason: "SHADOW mode — trade logged but not executed", checks: riskCheck.checks }) }], details: {} };
          }
          if (riskCheck.tier === "human_required") {
            const portfolio = await bankr.getPortfolioValue();
            const rc = await bankr.getRiskConfig();
            const riskAmount = portfolio * (rc.risk_per_trade_pct / 100);
            const approval = await telegram.requestTradeApproval({
              thesisId: params.thesis_id,
              asset: params.asset,
              direction: params.direction,
              leverage: `${params.leverage}x`,
              entryPrice: params.entry_price.toFixed(2),
              stopLoss: params.stop_price.toFixed(2),
              takeProfit: "TBD",
              riskAmount: riskAmount.toFixed(2),
              reason: `Tier: HUMAN REQUIRED. Mode: ${mode}`,
            });
            if (approval !== "approve") {
              return { content: [{ type: "text" as const, text: JSON.stringify({ executed: false, tier: "human_required", reason: `Trade ${approval} via Telegram` }) }], details: {} };
            }
          } else if (riskCheck.tier === "dead_zone") {
            await telegram.sendTradeAlert({
              type: "flagged",
              asset: params.asset,
              direction: params.direction,
              leverage: `${params.leverage}x`,
              entryPrice: params.entry_price.toFixed(2),
              reason: "Dead zone trade (20-30% capital) — executing but flagging",
            });
          }
          const result = await bankr.openPosition({ ...params, source: params.source });
          await telegram.sendTradeAlert({
            type: "executed",
            asset: params.asset,
            direction: params.direction,
            leverage: `${params.leverage}x`,
            entryPrice: params.entry_price.toFixed(2),
          });
          return { content: [{ type: "text" as const, text: JSON.stringify({ executed: true, tier: riskCheck.tier, position_id: result.position.id, size: result.position.size, bnkr_order_id: result.bnkr_order_id }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "bankr_close_position",
      label: "BANKR Close Position",
      description: "Close an open position by ID with a specified exit price and reason.",
      parameters: Type.Object({
        position_id: Type.String(),
        exit_price: Type.Number(),
        close_reason: Type.String({ description: "Reason: manual, take_profit, stop_loss, rsi_exit, kill_switch" }),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const record = await bankr.closePosition(params.position_id, params.exit_price, params.close_reason);
          if (!record) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Position not found" }) }], details: {} };
          await telegram.sendTradeAlert({
            type: "closed",
            asset: record.asset,
            direction: record.direction,
            exitPrice: params.exit_price.toFixed(2),
            pnl: record.pnl,
            reason: params.close_reason,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify({ closed: true, trade_id: record.id, pnl: record.pnl, pnl_pct: record.pnl_pct }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "bankr_positions",
      label: "BANKR Open Positions",
      description: "Get all open positions with current P&L.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const summary = await bankr.getPortfolioSummary();
          return { content: [{ type: "text" as const, text: JSON.stringify(summary) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "bankr_trade_history",
      label: "BANKR Trade History",
      description: "Get recent trade history with P&L and tax lot data.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max trades to return (default 20)" })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const history = await bankr.getTradeHistory();
          const limited = history.slice(-(params.limit || 20));
          return { content: [{ type: "text" as const, text: JSON.stringify({ total: history.length, trades: limited }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "bankr_tax_summary",
      label: "BANKR Tax Summary",
      description: "Get YTD tax summary with quarterly breakdown, estimated federal and NY tax.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const summary = await bankr.getTaxSummary();
          return { content: [{ type: "text" as const, text: JSON.stringify(summary) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
  ];
}

function buildOversightTools(): ToolDefinition[] {
  return [
    {
      name: "oversight_health_check",
      label: "Oversight Health Check",
      description: "Run a comprehensive health check on all Wealth Engines subsystems. Evaluates agent freshness, monitor heartbeat, kill switch, circuit breaker, data freshness, and job failures.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const report = await oversight.runHealthCheck();
          return { content: [{ type: "text" as const, text: JSON.stringify(report) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_performance_review",
      label: "Oversight Performance Review",
      description: "Generate a performance review for the specified period. Calculates win rate, Sharpe ratio, slippage, source attribution, and thesis conversion rate.",
      parameters: Type.Object({
        period_days: Type.Optional(Type.Number({ description: "Review period in days (default 7)" })),
      }),
      async execute(_toolCallId, params: { period_days?: number }) {
        try {
          const review = await oversight.runPerformanceReview(params.period_days ?? 7);
          return { content: [{ type: "text" as const, text: JSON.stringify(review) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_cross_domain_exposure",
      label: "Oversight Cross-Domain Exposure",
      description: "Detect correlated exposure between crypto positions and Polymarket positions. Flags when both domains have aligned bets on the same underlying asset or theme.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const alerts = await oversight.detectCrossDomainExposure();
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: alerts.length, alerts }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_improvement_queue",
      label: "Oversight Improvement Queue",
      description: "Get all improvement requests captured by the oversight system. Filter by status to see open, resolved, or dismissed items.",
      parameters: Type.Object({
        status: Type.Optional(Type.Union([
          Type.Literal("open"), Type.Literal("accepted"), Type.Literal("resolved"), Type.Literal("dismissed"),
        ], { description: "Filter by status. Default: all." })),
      }),
      async execute(_toolCallId, params: { status?: string }) {
        try {
          let queue = await oversight.getImprovementQueue();
          if (params.status) {
            queue = queue.filter(i => i.status === params.status);
          }
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: queue.length, items: queue }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_capture_improvement",
      label: "Oversight Capture Improvement",
      description: "Capture a new improvement request. Use when you identify an issue or optimization opportunity.",
      parameters: Type.Object({
        source: Type.Union([
          Type.Literal("health_check"), Type.Literal("performance_review"), Type.Literal("manual"), Type.Literal("circuit_breaker"),
        ], { description: "Source of the improvement" }),
        category: Type.Union([
          Type.Literal("risk"), Type.Literal("execution"), Type.Literal("signal"), Type.Literal("infrastructure"), Type.Literal("strategy"),
        ], { description: "Category of the improvement" }),
        severity: Type.Union([
          Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical"),
        ], { description: "Severity level" }),
        domain: Type.Optional(Type.Union([
          Type.Literal("crypto"), Type.Literal("polymarket"), Type.Literal("cross_domain"), Type.Literal("system"),
        ], { description: "Domain this improvement relates to" })),
        priority: Type.Optional(Type.Number({ description: "Priority (1=critical, 4=low). Auto-derived from severity if omitted." })),
        title: Type.String({ description: "Short title for the improvement" }),
        description: Type.String({ description: "Detailed description of the issue" }),
        pattern_description: Type.Optional(Type.String({ description: "Description of the pattern or trend that led to this improvement" })),
        recommendation: Type.String({ description: "Recommended action to address this" }),
        route: Type.Optional(Type.Union([
          Type.Literal("autoresearch"), Type.Literal("manual"), Type.Literal("bankr-config"),
        ], { description: "Where to route this improvement for resolution" })),
      }),
      async execute(_toolCallId, params: {
        source: "health_check" | "performance_review" | "manual" | "circuit_breaker";
        category: "risk" | "execution" | "signal" | "infrastructure" | "strategy";
        severity: "low" | "medium" | "high" | "critical";
        domain?: "crypto" | "polymarket" | "cross_domain" | "system";
        priority?: number;
        title: string; description: string; recommendation: string;
        pattern_description?: string;
        route?: "autoresearch" | "manual" | "bankr-config";
      }) {
        try {
          const item = await oversight.captureImprovement(params);
          return { content: [{ type: "text" as const, text: JSON.stringify(item) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_update_improvement",
      label: "Oversight Update Improvement",
      description: "Update the status of an improvement request.",
      parameters: Type.Object({
        id: Type.String({ description: "Improvement request ID" }),
        status: Type.Union([
          Type.Literal("accepted"), Type.Literal("resolved"), Type.Literal("dismissed"),
        ], { description: "New status" }),
        note: Type.Optional(Type.String({ description: "Resolution note" })),
      }),
      async execute(_toolCallId, params: { id: string; status: "accepted" | "resolved" | "dismissed"; note?: string }) {
        try {
          const item = await oversight.updateImprovement(params.id, params.status, params.note);
          if (!item) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Improvement not found" }) }], details: {} };
          return { content: [{ type: "text" as const, text: JSON.stringify(item) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_shadow_open",
      label: "Oversight Shadow Trade Open",
      description: "Open a hypothetical shadow trade to track what would have happened without real execution.",
      parameters: Type.Object({
        thesis_id: Type.String({ description: "Thesis ID that generated this signal" }),
        asset: Type.String({ description: "Asset name (e.g. BTC, ETH, or Polymarket question)" }),
        asset_class: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")], { description: "Asset class" }),
        source: Type.Union([Type.Literal("crypto_scout"), Type.Literal("polymarket_scout")], { description: "Signal source" }),
        direction: Type.String({ description: "LONG/SHORT for crypto, YES/NO for polymarket" }),
        entry_price: Type.Number({ description: "Entry price at signal time" }),
      }),
      async execute(_toolCallId, params: {
        thesis_id: string; asset: string; asset_class: "crypto" | "polymarket";
        source: "crypto_scout" | "polymarket_scout"; direction: string; entry_price: number;
      }) {
        try {
          const trade = await oversight.openShadowTrade(params);
          return { content: [{ type: "text" as const, text: JSON.stringify(trade) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_shadow_close",
      label: "Oversight Shadow Trade Close",
      description: "Close a shadow trade with an exit price and reason.",
      parameters: Type.Object({
        id: Type.String({ description: "Shadow trade ID" }),
        exit_price: Type.Number({ description: "Exit price" }),
        reason: Type.String({ description: "Close reason (e.g. stop_loss, take_profit, thesis_expired)" }),
      }),
      async execute(_toolCallId, params: { id: string; exit_price: number; reason: string }) {
        try {
          const trade = await oversight.closeShadowTrade(params.id, params.exit_price, params.reason);
          if (!trade) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Shadow trade not found" }) }], details: {} };
          return { content: [{ type: "text" as const, text: JSON.stringify(trade) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_shadow_trades",
      label: "Oversight Shadow Trades",
      description: "List shadow trades. Optionally filter by status (open or closed).",
      parameters: Type.Object({
        status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")], { description: "Filter by status" })),
      }),
      async execute(_toolCallId, params: { status?: "open" | "closed" }) {
        try {
          const trades = await oversight.getShadowTrades(params.status);
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: trades.length, trades }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_shadow_performance",
      label: "Oversight Shadow Performance",
      description: "Get aggregate shadow trading performance: total trades, win rate, P&L.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const perf = await oversight.getShadowPerformance();
          return { content: [{ type: "text" as const, text: JSON.stringify(perf) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_shadow_refresh",
      label: "Oversight Shadow Refresh",
      description: "Fetch live market prices for all open shadow trades and update their hypothetical P&L. Auto-closes trades older than 7 days.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await oversight.refreshShadowTradesFromMarket();
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_summary",
      label: "Oversight Summary",
      description: "Get a quick overview of oversight status: latest health report, drawdown status, active improvement details, and shadow trading stats.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const summary = await oversight.getOversightSummary();
          return { content: [{ type: "text" as const, text: JSON.stringify(summary) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_daily_summary",
      label: "Oversight Daily Summary",
      description: "Generate and optionally send the daily performance summary via Telegram.",
      parameters: Type.Object({
        send_telegram: Type.Optional(Type.Boolean({ description: "If true, also sends the summary via Telegram (default: false)" })),
      }),
      async execute(_toolCallId, params: { send_telegram?: boolean }) {
        try {
          if (params.send_telegram) {
            await oversight.sendDailyPerformanceSummary();
            return { content: [{ type: "text" as const, text: JSON.stringify({ sent: true }) }], details: {} };
          }
          const summary = await oversight.generateDailyPerformanceSummary();
          return { content: [{ type: "text" as const, text: summary }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_auto_shadow",
      label: "Oversight Auto Shadow Trade",
      description: "Automatically track a shadow trade for a thesis that BANKR chose not to execute (e.g., rejected by approval, outside parameters). Deduplicates by asset+direction. Carries over stop_price and target_price from the thesis for auto-close tracking.",
      parameters: Type.Object({
        thesis_id: Type.String({ description: "Thesis ID to shadow" }),
        asset: Type.String({ description: "Asset symbol" }),
        asset_class: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")], { description: "Asset class" }),
        source: Type.Union([Type.Literal("crypto_scout"), Type.Literal("polymarket_scout")], { description: "Signal source" }),
        direction: Type.String({ description: "Trade direction (LONG/SHORT/YES/NO)" }),
        entry_price: Type.Number({ description: "Entry price at time of shadow" }),
        reason: Type.String({ description: "Why this is being shadow-tracked instead of executed" }),
        stop_price: Type.Optional(Type.Number({ description: "Stop-loss price from thesis" })),
        target_price: Type.Optional(Type.Number({ description: "Take-profit price from thesis" })),
      }),
      async execute(_toolCallId: string, params: {
        thesis_id: string; asset: string;
        asset_class: "crypto" | "polymarket"; source: "crypto_scout" | "polymarket_scout";
        direction: string; entry_price: number; reason: string;
        stop_price?: number; target_price?: number;
      }) {
        try {
          const shadow = await oversight.autoTrackShadowTrade(params);
          if (shadow) {
            return { content: [{ type: "text" as const, text: JSON.stringify(shadow) }], details: {} };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify({ skipped: true, reason: "Already tracking this thesis/asset" }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_thesis_review",
      label: "Oversight Thesis Review",
      description: "Run adversarial bull/bear review on all active theses from SCOUT and Polymarket SCOUT. Evaluates confidence, track record, and thesis age to produce a verdict (bull_favored, bear_favored, neutral) with recommendation. Auto-captures improvements for bear-favored theses.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const reviews = await oversight.reviewTheses();
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: reviews.length, reviews }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "oversight_per_asset_losses",
      label: "Oversight Per-Asset Loss Check",
      description: "Check for concentrated per-asset losses over the last 7 days. Captures improvement requests when any single asset exceeds 10% portfolio loss.",
      parameters: Type.Object({}),
      async execute() {
        try {
          await oversight.checkPerAssetLosses();
          return { content: [{ type: "text" as const, text: JSON.stringify({ checked: true }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "autoresearch_run",
      label: "Autoresearch Run",
      description: "Run autoresearch parameter optimization experiments. Supports crypto, polymarket, or both domains. Backtests parameter mutations against historical data and keeps improvements.",
      parameters: Type.Object({
        domain: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket"), Type.Literal("both")], { description: "Which domain(s) to optimize" }),
        experiments_per_domain: Type.Optional(Type.Number({ description: "Number of experiments per domain (default 15)" })),
      }),
      async execute(_toolCallId: string, params: { domain: "crypto" | "polymarket" | "both"; experiments_per_domain?: number }) {
        try {
          const count = params.experiments_per_domain || 15;
          let summaries: autoresearch.ResearchRunSummary[];
          if (params.domain === "crypto") {
            summaries = [await autoresearch.runCryptoResearch(count)];
          } else if (params.domain === "polymarket") {
            summaries = [await autoresearch.runPolymarketResearch(count)];
          } else {
            summaries = await autoresearch.runFullResearch(count);
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(summaries) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "autoresearch_status",
      label: "Autoresearch Status",
      description: "Get current autoresearch status including active parameters for both crypto and polymarket, recent experiment history, and rollback availability.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const status = await autoresearch.getResearchStatus();
          return { content: [{ type: "text" as const, text: JSON.stringify(status) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "autoresearch_rollback",
      label: "Autoresearch Rollback",
      description: "Roll back parameters to the previous set for a given domain. Maintains up to 5 rollback points per domain.",
      parameters: Type.Object({
        domain: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")], { description: "Which domain to roll back" }),
      }),
      async execute(_toolCallId: string, params: { domain: "crypto" | "polymarket" }) {
        try {
          const result = await autoresearch.rollbackParams(params.domain);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "autoresearch_experiment_log",
      label: "Autoresearch Experiment Log",
      description: "Get the full experiment history showing all parameter mutations, their backtested scores, and whether they were kept or reverted.",
      parameters: Type.Object({
        domain: Type.Optional(Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")], { description: "Filter by domain" })),
        limit: Type.Optional(Type.Number({ description: "Number of recent experiments to return (default 20)" })),
      }),
      async execute(_toolCallId: string, params: { domain?: "crypto" | "polymarket"; limit?: number }) {
        try {
          const log = await autoresearch.getExperimentLog();
          let filtered = params.domain ? log.filter(e => e.domain === params.domain) : log;
          const limit = params.limit || 20;
          filtered = filtered.slice(-limit);
          return { content: [{ type: "text" as const, text: JSON.stringify(filtered) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      },
    },
    {
      name: "autoresearch_params",
      label: "Autoresearch Current Parameters",
      description: "Get the current optimized parameters for crypto signals or polymarket thresholds.",
      parameters: Type.Object({
        domain: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")], { description: "Which domain's parameters to retrieve" }),
      }),
      async execute(_toolCallId: string, params: { domain: "crypto" | "polymarket" }) {
        try {
          if (params.domain === "crypto") {
            const p = await autoresearch.getCryptoParams();
            return { content: [{ type: "text" as const, text: JSON.stringify(p) }], details: {} };
          }
          const p = await autoresearch.getPolymarketParams();
          return { content: [{ type: "text" as const, text: JSON.stringify(p) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
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

function buildMemoryTools(): ToolDefinition[] {
  return [
    {
      name: "memory_recall",
      label: "Memory Recall",
      description: "Search Rickin's long-term semantic memory for relevant context. Use this when you need to remember past conversations, decisions, preferences, or facts about Rickin that might not be in the current session. Returns ranked memory fragments with timestamps. Example queries: 'What does Rickin think about X?', 'What projects is Rickin working on?', 'What decisions were made about Y?'",
      parameters: Type.Object({
        query: Type.String({ description: "Natural language query to search memories. Be specific for better results." }),
        top_k: Type.Optional(Type.Number({ description: "Number of memories to return (default 10, max 25)" })),
      }),
      async execute(_toolCallId: string, params: any) {
        if (!hindsight.isConfigured()) {
          return { content: [{ type: "text" as const, text: "Memory recall is not configured. Set VECTORIZE_API_KEY, VECTORIZE_ORG_ID, and VECTORIZE_KB_ID to enable." }], details: {} };
        }

        const topK = Math.min(params.top_k || 10, 25);
        const result = await hindsight.recall({ query: params.query, topK });

        if (result.memories.length === 0) {
          return { content: [{ type: "text" as const, text: `No memories found matching "${params.query}".` }], details: {} };
        }

        const formatted = result.memories.map((m, i) => {
          const score = (m.score * 100).toFixed(0);
          const date = m.createdAt ? new Date(m.createdAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "unknown";
          const meta = m.metadata?.type ? ` [${m.metadata.type}]` : "";
          return `${i + 1}. (${score}% match, ${date}${meta}) ${m.text}`;
        }).join("\n");

        return { content: [{ type: "text" as const, text: `Found ${result.memories.length} relevant memories:\n\n${formatted}` }], details: {} };
      },
    },
    {
      name: "memory_reflect",
      label: "Memory Reflect",
      description: "Consolidate and reflect on accumulated memories. Calls the Hindsight knowledge graph reflect operation to surface patterns, recurring themes, and insights across all stored memories. Use this for weekly memory digests or when asked 'what patterns do you see in my activity?'",
      parameters: Type.Object({}),
      async execute() {
        if (!hindsight.isConfigured()) {
          return { content: [{ type: "text" as const, text: "Memory reflect is not configured. Set VECTORIZE_API_KEY, VECTORIZE_ORG_ID, and VECTORIZE_KB_ID to enable." }], details: {} };
        }

        const result = await hindsight.reflect();

        const lines = [`**Memory Reflection**\n`, result.summary, ""];
        if (result.patterns.length > 0) {
          lines.push("**Recurring Patterns:**");
          result.patterns.forEach(p => lines.push(`- ${p}`));
          lines.push("");
        }
        if (result.insights.length > 0) {
          lines.push("**Insights:**");
          result.insights.forEach(i => lines.push(`- ${i}`));
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
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

          const domain = "rickin.live";
          const pageUrl = `https://${domain}/pages/${slug}`;

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
          const domain = "rickin.live";
          const list = files.map(f => {
            const slug = f.replace(/\.html$/, "");
            const stat = fs.statSync(path.join(pagesDir, f));
            const sizeKB = Math.round(stat.size / 1024);
            const date = stat.mtime.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            return `- ${slug} (${sizeKB}KB, ${date}) — https://${domain}/pages/${slug}`;
          }).join("\n");
          return {
            content: [{ type: "text" as const, text: `${files.length} saved page(s):\n\n${list}\n\nAll pages: https://${domain}/pages` }],
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
        agent: Type.String({ description: "The specialist agent ID. Available agents: 'deep-researcher' (web research), 'project-planner' (project plans), 'email-drafter' (compose emails), 'analyst' (markets/stocks), 'moodys' (Moody's/ValidMind/work projects — use for ANY work-related task), 'real-estate' (property search), 'nutritionist' (meal planning), 'family-planner' (financial/legal planning), 'knowledge-organizer' (vault management), 'mindmap-generator' (create mind maps from vault topics — use when user says 'map out', 'visualize', 'mind map', or 'mindmap')" }),
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
          let savedTo: string | undefined;
          if (result.response && result.response.length > 200) {
            try {
              const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
              savedTo = `Scheduled Reports/Agent Results/${params.agent}-${ts}.md`;
              await kbCreate(savedTo, `# ${params.agent} result\n*Task: ${params.task.slice(0, 200)}*\n*Duration: ${((result.durationMs || 0) / 1000).toFixed(0)}s*\n\n${result.response}`);
            } catch { savedTo = undefined; }
          }
          const sessionEntry2 = sessions.get(sessionId);
          try {
            const pool = db.getPool();
            await pool.query(
              `INSERT INTO agent_activity (agent, task, conversation_id, conversation_title, duration_ms, saved_to, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [params.agent, params.task.slice(0, 200), sessionEntry2?.conversation?.id || null, sessionEntry2?.conversation?.title || null, result.durationMs || null, savedTo || null, Date.now()]
            );
            await pool.query(`DELETE FROM agent_activity WHERE id NOT IN (SELECT id FROM agent_activity ORDER BY created_at DESC LIMIT 50)`);
          } catch (e: any) { console.warn("[agent_activity] DB insert failed:", e.message); }
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
  planningMode: boolean;
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
  let augmentedText = `[Current date/time in Rickin's timezone (Eastern): ${etNow}]\n\n${queueContext}`;
  if (entry.planningMode) {
    augmentedText += `[PLANNING MODE] Before taking any action or calling any tools, you must first present a clear, numbered plan of what you intend to do. Explain each step briefly. Then ask for my approval before proceeding. Do NOT execute any tools or actions until I explicitly confirm the plan (e.g. "go ahead", "yes", "approved", "do it"). If I ask you to modify the plan, revise it and ask for approval again.\n\n`;
  }
  augmentedText += pending.text;
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

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!APP_PASSWORD) { next(); return; }
  if (AUTH_PUBLIC_PATHS.has(req.path)) { next(); return; }
  if (req.path === "/api/config/tunnel-url") { next(); return; }
  if (req.path === "/api/gmail/callback") { next(); return; }
  if (req.path === "/api/gmail/auth") { next(); return; }
  if (req.path === "/api/telegram/webhook") { next(); return; }

  if (req.path === "/pages/wealth-engines" || req.path === "/api/wealth-engines/data") {
    try {
      const dbMod = await import("./src/db.js");
      const pool = dbMod.getPool();
      const pubRes = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_public'`);
      if (pubRes.rows.length > 0 && (pubRes.rows[0].value === true || pubRes.rows[0].value === "true")) {
        next(); return;
      }
    } catch {}
  }

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

let dailyBriefCache: { data: any; ts: number } | null = null;
let welcomeCache: { message: string; ts: number } | null = null;
const WELCOME_CACHE_TTL = 30 * 60 * 1000;

async function generateWelcomeMessage(context: { greeting: string; dayOfWeek: string; tempC: number | null; condition: string | null; taskCount: number; eventCount: number; babyWeeks: number | null }): Promise<string> {
  try {
    if (welcomeCache && Date.now() - welcomeCache.ts < WELCOME_CACHE_TTL) return welcomeCache.message;
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const weatherPart = context.tempC !== null && context.condition ? `Current weather in NYC: ${context.tempC}°C, ${context.condition}.` : "";
    const babyPart = context.babyWeeks !== null ? `His wife is ${context.babyWeeks} weeks pregnant with a baby boy.` : "";
    const prompt = `Generate a friendly morning briefing for Rickin who is checking his daily dashboard. Time: ${context.greeting.toLowerCase()} on ${context.dayOfWeek}. ${weatherPart} He has ${context.taskCount} tasks and ${context.eventCount} calendar events today. ${babyPart}

Format as a short greeting line followed by bullet points summarizing what's ahead. Use this exact format:
[greeting line]
• [weather note]
• [tasks/calendar summary]
• [baby milestone or encouragement]
• [motivational or day-specific note]

Keep each bullet concise (under 15 words). Don't use emojis. Don't say "I" or reference yourself. 4-5 bullets max.`;
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (response.content[0] as any).text?.trim() || "";
    if (text) {
      welcomeCache = { message: text, ts: Date.now() };
      return text;
    }
  } catch (err) {
    console.error("Welcome message generation failed:", err);
  }
  return `${context.greeting}, Rickin. Here's your brief for ${context.dayOfWeek}.`;
}
const DAILY_BRIEF_TTL = 1_800_000;

async function fetchQuoteStructured(symbol: string, type: "stock" | "crypto"): Promise<any> {
  try {
    if (type === "crypto") {
      const CRYPTO_MAP: Record<string, string> = { BTCUSD: "bitcoin", ETHUSD: "ethereum" };
      const coinId = CRYPTO_MAP[symbol.toUpperCase()] || symbol.toLowerCase();
      const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
      const res = await fetch(url, { headers: { "User-Agent": "pi-assistant/1.0" } });
      if (!res.ok) return null;
      const data = await res.json() as any;
      const m = data.market_data;
      if (!m?.current_price?.usd) return null;
      return {
        symbol: data.symbol.toUpperCase(),
        name: data.name,
        price: m.current_price.usd,
        change24h: m.price_change_percentage_24h || 0,
        change7d: m.price_change_percentage_7d || 0,
        high24h: m.high_24h?.usd,
        low24h: m.low_24h?.usd,
        marketCap: m.market_cap?.usd,
      };
    } else {
      const ticker = symbol.toUpperCase();
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d&includePrePost=false`;
      const res = await fetch(url, { headers: { "User-Agent": "pi-assistant/1.0" } });
      if (!res.ok) return null;
      const data = await res.json() as any;
      const result = data?.chart?.result?.[0];
      if (!result) return null;
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      if (price == null) return null;
      const prevClose = meta.chartPreviousClose || meta.previousClose;
      const change = prevClose ? price - prevClose : 0;
      const changePct = prevClose ? (change / prevClose) * 100 : 0;
      return {
        symbol: ticker,
        name: meta.shortName || meta.longName || ticker,
        price,
        change,
        changePct,
        prevClose,
        currency: meta.currency || "USD",
      };
    }
  } catch { return null; }
}

app.get("/api/vault/reya-school", async (_req: Request, res: Response) => {
  try {
    const tz = "America/New_York";
    const now = new Date();
    const dayName = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
    const isWeekend = ["Saturday", "Sunday"].includes(dayName);
    if (isWeekend) {
      res.json({ schoolInSession: false, lunch: null, pickupCountdown: null, alert: null });
      return;
    }
    const month = parseInt(now.toLocaleString("en-US", { timeZone: tz, month: "numeric" }));
    const day = parseInt(now.toLocaleString("en-US", { timeZone: tz, day: "numeric" }));
    let lunch = "Menu not available";
    try {
      const mealFile = await kbRead("Family/Reya's Education/Reya - School Meals.md");
      if (mealFile) {
        const datePattern = new RegExp(`\\|\\s*\\w+\\s+${month}/${day}\\s*\\|([^|]+)\\|([^|]+)\\|([^|]+)\\|`, "i");
        const match = mealFile.match(datePattern);
        if (match) {
          const mainDish = match[1].replace(/\*\*/g, "").trim();
          const vegStatus = match[2].trim();
          const sides = match[3].trim();
          const isVeg = vegStatus.includes("✅");
          lunch = isVeg ? `✅ ${mainDish}` : `❌ ${mainDish} — Sides: ${sides}`;
        }
      }
    } catch {}
    const etNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const pickupTime = new Date(etNow);
    pickupTime.setHours(16, 30, 0, 0);
    let pickupCountdown: string | null = null;
    if (etNow < pickupTime) {
      const diffMs = pickupTime.getTime() - etNow.getTime();
      const h = Math.floor(diffMs / 3600000);
      const m = Math.floor((diffMs % 3600000) / 60000);
      pickupCountdown = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
    } else {
      pickupCountdown = "✅ Picked up";
    }
    let alert: string | null = null;
    try {
      if (gmail.isConnected()) {
        const alerts = await gmail.searchEmailsStructured("from:kristen OR from:cicio is:unread newer_than:2d", 1);
        if (alerts.length > 0) alert = alerts[0].subject;
      }
    } catch {}
    res.json({ schoolInSession: true, lunch, pickupCountdown, alert });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Reya school data" });
  }
});

app.get("/api/vault/moodys-brief", async (_req: Request, res: Response) => {
  try {
    const tz = "America/New_York";
    const now = new Date();
    const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
    const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
    const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
    const dateStr = `${year}-${month}-${day}`;
    const paths = [
      `Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Brief.md`,
    ];
    const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
    let briefContent: string | null = null;
    let briefDate = dateStr;
    if (etHour >= 6) {
      for (const p of paths) {
        try {
          const content = await kbRead(p);
          if (content && content.length > 100) { briefContent = content; break; }
        } catch {}
      }
    }
    if (!briefContent) {
      const yesterday = new Date(now.getTime() - 86400000);
      const yYear = yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
      const yMonth = yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
      const yDay = yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
      const yDateStr = `${yYear}-${yMonth}-${yDay}`;
      try {
        const content = await kbRead(`Scheduled Reports/Moody's Intelligence/Daily/${yDateStr}-Brief.md`);
        if (content && content.length > 100) { briefContent = content; briefDate = yDateStr; }
      } catch {}
    }
    if (!briefContent) {
      res.json({ available: false, reason: "missing", message: "Brief unavailable — check pipeline" });
      return;
    }
    const categories: Record<string, string[]> = { corporate: [], banking: [], competitors: [], aiTrends: [], analysts: [] };
    const MAX_PER_CAT = 5;

    const sectionMap: Array<{ pattern: RegExp; key: string }> = [
      { pattern: /^##\s+🏢\s+Moody/im, key: "corporate" },
      { pattern: /^##\s+🏦\s+Banking/im, key: "banking" },
      { pattern: /^##\s+🔍\s+Competitor/im, key: "competitors" },
      { pattern: /^##\s+🤖\s+Enterprise\s*AI/im, key: "aiTrends" },
      { pattern: /^##\s+📊\s+Industry\s*Analyst/im, key: "analysts" },
    ];
    const bLines = briefContent.split("\n");
    let curKey: string | null = null;
    for (const line of bLines) {
      for (const { pattern, key } of sectionMap) {
        if (pattern.test(line)) { curKey = key; break; }
      }
      if (/^##\s+⚡\s+Key\s+Takeaway/i.test(line) || /^##\s+🐦/i.test(line)) { curKey = null; continue; }
      if (curKey && /^-\s+.+/.test(line)) {
        if (categories[curKey].length < MAX_PER_CAT) {
          let text = line.replace(/^-\s+/, "").replace(/🔴|🟡|🟢/g, "").replace(/\*\*/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
          if (text.length > 160) text = text.slice(0, 157) + "...";
          if (text) categories[curKey].push(text);
        }
      }
    }

    let totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);

    if (totalItems === 0) {
      const catKeywords: Array<{ pattern: RegExp; key: string }> = [
        { pattern: /moody'?s\s*corporate/i, key: "corporate" },
        { pattern: /banking/i, key: "banking" },
        { pattern: /competitor/i, key: "competitors" },
        { pattern: /enterprise\s*ai/i, key: "aiTrends" },
        { pattern: /industry\s*analyst/i, key: "analysts" },
      ];
      const tableRows = briefContent.match(/^\|[^|]*\|[^|]*\|[^|]*\|/gm) || [];
      for (const row of tableRows) {
        const cells = row.split("|").map(c => c.trim()).filter(Boolean);
        if (cells.length < 3 || /^[#-]+$/.test(cells[0])) continue;
        const item = cells[1].replace(/\*\*/g, "").replace(/\(?\[.*?\]\(.*?\)\)?/g, "").trim();
        const catCell = cells[2];
        if (!item || !catCell || /^Category$/i.test(catCell) || /^-+$/.test(catCell)) continue;
        for (const { pattern, key } of catKeywords) {
          if (pattern.test(catCell)) {
            if (categories[key].length < MAX_PER_CAT) {
              const clean = item.length > 160 ? item.slice(0, 157) + "..." : item;
              categories[key].push(clean);
            }
            break;
          }
        }
      }
      totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);
    }

    if (totalItems === 0) {
      const bullets = briefContent.match(/^- .+$/gm) || [];
      if (bullets.length === 0) {
        res.json({ available: false, reason: "unstructured", message: "Brief format not recognized" });
        return;
      }
      for (const b of bullets.slice(0, 5)) {
        let text = b.replace(/^- /, "").replace(/\*\*/g, "").trim();
        if (text.length > 160) text = text.slice(0, 157) + "...";
        categories.corporate.push(text);
      }
    }
    const tsMatch = briefContent.match(/Generated:\s*(.+)/);
    res.json({ available: true, date: briefDate, categories, timestamp: tsMatch ? tsMatch[1].trim() : null });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Moody's brief" });
  }
});

app.get("/api/vault/real-estate-scan", async (_req: Request, res: Response) => {
  try {
    const tz = "America/New_York";
    const now = new Date();
    const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
    const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
    const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
    const dateStr = `${year}-${month}-${day}`;
    let scanContent: string | null = null;
    let scanDate = dateStr;
    try {
      const content = await kbRead(`Scheduled Reports/Real Estate/${dateStr}-Property-Scan.md`);
      if (content) scanContent = content;
    } catch {}
    if (!scanContent) {
      const yesterday = new Date(now.getTime() - 86400000);
      const yDateStr = `${yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" })}`;
      try {
        const content = await kbRead(`Scheduled Reports/Real Estate/${yDateStr}-Property-Scan.md`);
        if (content) { scanContent = content; scanDate = yDateStr; }
      } catch {}
    }
    if (!scanContent) {
      res.json({ available: false });
      return;
    }
    const scannedMatch = scanContent.match(/\*\*(\d+)\+?\s*listings?\s*scanned\*\*/i);
    const totalListings = scannedMatch ? parseInt(scannedMatch[1]) : 0;
    const newMatch = scanContent.match(/\*\*(\d+)\s*new\s*listings?\*\*/i);
    const newListings = newMatch ? parseInt(newMatch[1]) : 0;
    const tsMatch = scanContent.match(/Generated:\s*(.+)/);
    const scanTime = tsMatch ? tsMatch[1].trim() : null;
    res.json({ available: true, date: scanDate, totalListings, newListings, scanTime });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch real estate scan" });
  }
});

let xIntelCache: { data: any; ts: number } | null = null;
const X_INTEL_TTL = 30 * 60 * 1000;
const AI_FILTER_THRESHOLD = 7;

async function filterTweetsWithAI(sectionName: string, tweets: any[]): Promise<any[]> {
  if (!tweets || tweets.length === 0 || !ANTHROPIC_KEY) return tweets;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY, timeout: 5000 });
    const tweetList = tweets.map((t, i) => `[${i}] @${t.handle}: ${(t.text || "").slice(0, 280)}`).join("\n");
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: `Score these ${sectionName} tweets 1-10 for importance/newsworthiness.\nScore 7+ = breaking news, significant development, novel expert insight.\nScore <7 = opinion, self-promotion, old news, noise, engagement bait.\nFor each scoring 7+, write a one-line insight (max 15 words) explaining why it matters.\nReturn ONLY valid JSON array: [{\"index\":0,\"score\":8,\"insight\":\"...\"}]\n\n${tweetList}` }],
      system: "You are a senior intelligence analyst. Return ONLY a JSON array, no other text.",
    });
    const text = response.content.map((b: any) => b.type === "text" ? b.text : "").join("");
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return tweets;
    const scores: Array<{ index: number; score: number; insight?: string }> = JSON.parse(jsonMatch[0]);
    const filtered: any[] = [];
    for (const s of scores) {
      if (s.score >= AI_FILTER_THRESHOLD && s.index >= 0 && s.index < tweets.length) {
        filtered.push({ ...tweets[s.index], score: s.score, insight: s.insight || "" });
      }
    }
    return filtered;
  } catch (err: any) {
    console.warn(`[x-intel] AI filter failed for ${sectionName}:`, err.message);
    return tweets;
  }
}

async function fetchXIntelData(): Promise<Record<string, { visionaries: any[]; headlines: any[]; filtered?: boolean }>> {
  const xIntelSections: Record<string, { visionaries: string[]; headlines: string[] }> = {
    breaking: {
      visionaries: ["DeItaone", "unusual_whales", "sentdefender", "pmarca", "IntelCrab", "spectatorindex", "zeynep", "BillAckman", "ElbridgeColby", "adam_tooze"],
      headlines: ["Reuters", "AP", "BBCBreaking", "business", "CNN", "CNBC", "AJEnglish", "axios", "politico", "FT"],
    },
    global: {
      visionaries: ["ianbremmer", "michaelxpettis", "RnaudBertrand", "Jkylebass", "FareedZakaria", "RichardHaass", "PeterZeihan", "anneapplebaum", "nouriel", "BrankoMilan"],
      headlines: ["BBCWorld", "nytimes", "TheEconomist", "ForeignPolicy", "ForeignAffairs", "guardian", "CFR_org", "AJEnglish", "FRANCE24", "DWNews"],
    },
    macro: {
      visionaries: ["LynAldenContact", "NickTimiraos", "LukeGromen", "josephwang", "RaoulGMI", "biancoresearch", "elerianm", "naval", "KobeissiLetter", "balajis"],
      headlines: ["FT", "WSJ", "business", "TheEconomist", "IMFNews", "federalreserve", "BISbank", "CNBC", "axios", "markets"],
    },
    techAi: {
      visionaries: ["karpathy", "sama", "DarioAmodei", "emollick", "AndrewYNg", "AravSrinivas", "ylecun", "DrJimFan", "gdb", "alexandr_wang"],
      headlines: ["Wired", "TechCrunch", "verge", "ArsTechnica", "VentureBeat", "NewScientist", "axios", "CNBC"],
    },
    bitcoin: {
      visionaries: ["saylor", "LynAldenContact", "APompliano", "PrestonPysh", "dergigi", "pete_rizzo_", "bitfinexed", "KobeissiLetter", "balajis", "naval"],
      headlines: ["CoinDesk", "Cointelegraph", "theblockCrypto", "BitcoinMagazine", "DecryptMedia", "TheDefiant", "WuBlockchain", "cryptobriefing"],
    },
  };
  function pickRandom<T>(arr: T[], n: number): T[] {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }
  const xIntelResult: Record<string, { visionaries: any[]; headlines: any[] }> = {};
  const sections = Object.entries(xIntelSections);
  for (const [section] of sections) {
    xIntelResult[section] = { visionaries: [], headlines: [] };
  }
  const allFetches: Array<{ section: string; type: "visionaries" | "headlines"; handle: string }> = [];
  for (const [section, handles] of sections) {
    const pickedVis = pickRandom(handles.visionaries, 7);
    const pickedHead = pickRandom(handles.headlines, 7);
    for (const h of pickedVis) allFetches.push({ section, type: "visionaries", handle: h });
    for (const h of pickedHead) allFetches.push({ section, type: "headlines", handle: h });
  }
  let fetchOk = 0, fetchFail = 0;
  const BATCH = 8;
  for (let i = 0; i < allFetches.length; i += BATCH) {
    if (i > 0) await new Promise(r => setTimeout(r, 500));
    const batch = allFetches.slice(i, i + BATCH);
    await Promise.all(batch.map(async (f) => {
      try {
        const tweets = await twitter.getUserTimelineStructured(f.handle, 2);
        if (tweets.length > 0) {
          xIntelResult[f.section][f.type].push(...tweets);
          fetchOk++;
        } else {
          fetchFail++;
        }
      } catch {
        fetchFail++;
      }
    }));
  }
  console.log(`[x-intel] Fetched ${allFetches.length} handles: ${fetchOk} ok, ${fetchFail} empty/failed`);

  const filterStatus: Record<string, boolean> = {};
  const filterPromises: Promise<void>[] = [];
  for (const [section, data] of Object.entries(xIntelResult)) {
    filterStatus[section] = false;
    if (data.visionaries.length > 0) {
      filterPromises.push(
        filterTweetsWithAI(`${section}/visionaries`, data.visionaries).then(filtered => {
          if (filtered.some((t: any) => t.score !== undefined)) filterStatus[section] = true;
          data.visionaries = filtered;
        })
      );
    }
    if (data.headlines.length > 0) {
      filterPromises.push(
        filterTweetsWithAI(`${section}/headlines`, data.headlines).then(filtered => {
          if (filtered.some((t: any) => t.score !== undefined)) filterStatus[section] = true;
          data.headlines = filtered;
        })
      );
    }
  }
  await Promise.all(filterPromises);

  for (const [section, data] of Object.entries(xIntelResult)) {
    (data as any).filtered = filterStatus[section];
  }

  return xIntelResult;
}

app.get("/api/wealth-engines/theses", async (_req: Request, res: Response) => {
  try {
    const theses = await cryptoScout.getActiveTheses();
    res.json({ count: theses.length, theses });
  } catch (err: any) {
    console.error("[wealth-engines] theses error:", err);
    res.status(500).json({ error: "Failed to fetch theses" });
  }
});

app.get("/api/wealth-engines/watchlist", async (_req: Request, res: Response) => {
  try {
    const watchlist = await cryptoScout.getWatchlist();
    res.json({ count: watchlist.length, assets: watchlist });
  } catch (err: any) {
    console.error("[wealth-engines] watchlist error:", err);
    res.status(500).json({ error: "Failed to fetch watchlist" });
  }
});

app.get("/api/wealth-engines/positions", async (_req: Request, res: Response) => {
  try {
    const summary = await bankr.getPortfolioSummary();
    res.json(summary);
  } catch (err: any) {
    console.error("[wealth-engines] positions error:", err);
    res.status(500).json({ error: "Failed to fetch positions" });
  }
});

app.get("/api/wealth-engines/trades", async (_req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(_req.query.limit)) || 50, 1), 200);
    const history = await bankr.getTradeHistory();
    res.json({ total: history.length, trades: history.slice(-limit) });
  } catch (err: any) {
    console.error("[wealth-engines] trades error:", err);
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});

app.get("/api/wealth-engines/tax/summary", async (_req: Request, res: Response) => {
  try {
    const summary = await bankr.getTaxSummary();
    res.json(summary);
  } catch (err: any) {
    console.error("[wealth-engines] tax summary error:", err);
    res.status(500).json({ error: "Failed to fetch tax summary" });
  }
});

app.get("/api/wealth-engines/tax/8949", async (_req: Request, res: Response) => {
  try {
    const csv = await bankr.generateForm8949CSV();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="form-8949-${new Date().getFullYear()}.csv"`);
    res.send(csv);
  } catch (err: any) {
    console.error("[wealth-engines] 8949 error:", err);
    res.status(500).json({ error: "Failed to generate Form 8949" });
  }
});

app.get("/api/wealth-engines/export", async (_req: Request, res: Response) => {
  try {
    const [positions, trades, taxSummary, cryptoTheses, pmTheses, watchlist, portfolio] = await Promise.all([
      bankr.getPositions(),
      bankr.getTradeHistory(),
      bankr.getTaxSummary(),
      cryptoScout.getActiveTheses(),
      polymarketScout.getActiveTheses(),
      cryptoScout.getWatchlist(),
      bankr.getPortfolioValue(),
    ]);
    res.json({
      exported_at: new Date().toISOString(),
      portfolio_value: portfolio,
      positions,
      trade_history: trades,
      tax_summary: taxSummary,
      crypto_theses: cryptoTheses,
      polymarket_theses: pmTheses,
      watchlist,
    });
  } catch (err: any) {
    console.error("[wealth-engines] export error:", err);
    res.status(500).json({ error: "Failed to export data" });
  }
});

app.get("/api/wealth-engines/polymarket/theses", async (_req: Request, res: Response) => {
  try {
    const theses = await polymarketScout.getActiveTheses();
    res.json({ count: theses.length, theses });
  } catch (err: any) {
    console.error("[wealth-engines] pm theses error:", err);
    res.status(500).json({ error: "Failed to fetch polymarket theses" });
  }
});

app.get("/api/wealth-engines/oversight", async (_req: Request, res: Response) => {
  try {
    const summary = await oversight.getOversightSummary();
    res.json(summary);
  } catch (err: any) {
    console.error("[wealth-engines] oversight error:", err);
    res.status(500).json({ error: "Failed to fetch oversight data" });
  }
});

let weDashboardCache: { data: any; ts: number } | null = null;
const WE_DASHBOARD_TTL = 30_000;

async function buildWealthEnginesDashboardData(): Promise<any> {
  const [summary, tradeHistory, pmTheses, cryptoTheses, oversightData, shadowPerf, researchStatus, fearGreed] = await Promise.all([
    bankr.getPortfolioSummary(),
    bankr.getTradeHistory(),
    polymarketScout.getActiveTheses().catch(() => []),
    cryptoScout.getActiveTheses().catch(() => []),
    oversight.getOversightSummary().catch(() => null),
    oversight.getShadowPerformance().catch(() => ({ total_trades: 0, open_trades: 0, closed_trades: 0, total_pnl: 0, win_rate: 0, avg_pnl: 0, trades: [] })),
    autoresearch.getResearchStatus().catch(() => null),
    signalSources.getFearGreedIndex().catch(() => null),
  ]);

  const recentTrades = tradeHistory.slice(-20).reverse();
  const totalRealizedPnl = tradeHistory.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);

  const pool = (await import("./src/db.js")).getPool();
  let scoutLastRun: string | null = null;
  let scoutSummary: string | null = null;
  let monitorLastTick: string | null = null;
  let pmLastRun: string | null = null;

  let scoutRegime: string | null = null;
  try {
    const scoutRes = await pool.query(`SELECT created_at, summary FROM job_history WHERE job_id IN ('scout-micro-scan', 'scout-full-cycle') ORDER BY created_at DESC LIMIT 1`);
    if (scoutRes.rows.length > 0) {
      scoutLastRun = scoutRes.rows[0].created_at;
      const raw = scoutRes.rows[0].summary || "";
      scoutSummary = raw.length > 500 ? raw.slice(0, 500) + "..." : raw;
      const regimeMatch = raw.match(/(?:Regime\s*[:\|]\s*|[\|]\s*)(TRENDING|RANGING|VOLATILE|BEARISH|BULLISH)(?:\s*[\|])/i);
      if (regimeMatch) scoutRegime = regimeMatch[1].toUpperCase();
    }
  } catch (err) { console.warn("[wealth-engines] scout query failed:", err instanceof Error ? err.message : err); }

  try {
    const pmRes = await pool.query(`SELECT created_at FROM job_history WHERE job_id IN ('polymarket-activity-scan', 'polymarket-full-cycle') ORDER BY created_at DESC LIMIT 1`);
    if (pmRes.rows.length > 0) pmLastRun = pmRes.rows[0].created_at;
  } catch (err) { console.warn("[wealth-engines] pm last run query failed:", err instanceof Error ? err.message : err); }

  try {
    const tickRes = await pool.query(`SELECT value FROM app_config WHERE key = 'bankr_monitor_last_tick'`);
    if (tickRes.rows.length > 0) monitorLastTick = new Date(parseInt(String(tickRes.rows[0].value))).toISOString();
  } catch (err) { console.warn("[wealth-engines] monitor tick query failed:", err instanceof Error ? err.message : err); }

  let oversightLastRun: string | null = null;
  try {
    const osRes = await pool.query(`SELECT created_at FROM job_history WHERE job_id = 'oversight-health' ORDER BY created_at DESC LIMIT 1`);
    if (osRes.rows.length > 0) oversightLastRun = osRes.rows[0].created_at;
  } catch {}

  let agentActivity: Array<{ job_id: string; created_at: string; summary: string; status: string }> = [];
  try {
    const actRes = await pool.query(`SELECT job_id, created_at, summary, status FROM job_history ORDER BY created_at DESC LIMIT 15`);
    agentActivity = actRes.rows.map((r: any) => ({ job_id: r.job_id, created_at: r.created_at, summary: (r.summary || "").slice(0, 200), status: r.status || "completed" }));
  } catch {}

  const now = Date.now();
  const scoutHealthy = scoutLastRun ? (now - new Date(scoutLastRun).getTime()) < 6 * 60 * 60_000 : false;
  const monitorHealthy = monitorLastTick ? (now - new Date(monitorLastTick).getTime()) < 30 * 60_000 : false;
  const oversightHealthy = oversightLastRun ? (now - new Date(oversightLastRun).getTime()) < 8 * 60 * 60_000 : false;

  const topPmThesis = pmTheses.length > 0 ? (pmTheses[0].question || pmTheses[0].market_question || "").slice(0, 100) : null;

  const now24h = now - 24 * 60 * 60_000;
  const now7d = now - 7 * 24 * 60 * 60_000;
  const dailyTrades = tradeHistory.filter((t: any) => new Date(t.closed_at).getTime() > now24h);
  const weeklyTrades = tradeHistory.filter((t: any) => new Date(t.closed_at).getTime() > now7d);
  const dailyPnl = dailyTrades.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);
  const weeklyPnl = weeklyTrades.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);
  const totalWins = tradeHistory.filter((t: any) => (t.pnl || 0) > 0).length;
  const winRate = tradeHistory.length > 0 ? (totalWins / tradeHistory.length * 100) : 0;
  const availableUsdc = Math.max(0, summary.portfolio_value - summary.total_exposure);

  return {
    timestamp: new Date().toISOString(),
    portfolio_value: summary.portfolio_value,
    peak_portfolio_value: summary.peak_portfolio_value,
    peak_drawdown_pct: summary.peak_drawdown_pct,
    consecutive_losses: summary.consecutive_losses,
    total_exposure: summary.total_exposure,
    unrealized_pnl: summary.unrealized_pnl,
    total_realized_pnl: totalRealizedPnl,
    daily_pnl: parseFloat(dailyPnl.toFixed(4)),
    weekly_pnl: parseFloat(weeklyPnl.toFixed(4)),
    available_usdc: parseFloat(availableUsdc.toFixed(2)),
    initial_capital: summary.initial_capital || 1000,
    total_trades: tradeHistory.length,
    win_rate: parseFloat(winRate.toFixed(1)),
    mode: summary.mode,
    paused: summary.paused,
    kill_switch: summary.kill_switch,
    positions: summary.positions,
    recent_trades: recentTrades,
    crypto_theses: cryptoTheses.slice(0, 10).map((t: any) => ({
      id: t.id, asset: t.asset, direction: t.direction, confidence: t.confidence,
      entry_price: t.entry_price, stop_loss: t.stop_price || t.stop_loss, take_profit: t.exit_price || t.take_profit,
      reasoning: t.reasoning || "", created_at: t.created_at, status: t.status,
      vote_count: t.vote_count || null, time_horizon: t.time_horizon || null,
      sources: t.sources || [], market_regime: t.market_regime || null,
      technical_score: t.technical_score || null,
    })),
    polymarket_theses: pmTheses.slice(0, 10).map((t: any) => ({
      id: t.id, question: t.asset || t.question || t.market_question, direction: t.direction,
      confidence: t.confidence, whale_consensus: t.whale_consensus,
      current_odds: t.current_odds, entry_odds: t.entry_odds, exit_odds: t.exit_odds,
      volume: t.volume, category: t.category, reasoning: t.reasoning || "",
      sources: t.sources || [],
      created_at: t.created_at, expires_at: t.expires_at, status: t.status,
    })),
    scout: {
      crypto_last_run: scoutLastRun,
      crypto_regime: scoutRegime,
      crypto_summary: scoutSummary,
      crypto_theses_count: cryptoTheses.length,
      pm_theses_count: pmTheses.length,
      pm_top_thesis: topPmThesis,
      pm_last_run: pmLastRun,
      fear_greed: fearGreed ? { value: fearGreed.value, classification: fearGreed.classification, regime_signal: fearGreed.regime_signal } : null,
    },
    oversight: oversightData ? {
      health_status: oversightData.health?.overall_status || "unknown",
      health_checks: oversightData.health?.checks || [],
      drawdown: oversightData.drawdown,
      improvements: oversightData.improvements,
      last_check: oversightData.last_check,
      last_run: oversightLastRun,
    } : null,
    shadow: {
      total_trades: shadowPerf.total_trades,
      open_trades: shadowPerf.open_trades,
      closed_trades: shadowPerf.closed_trades,
      total_pnl: shadowPerf.total_pnl,
      win_rate: shadowPerf.win_rate,
      avg_pnl: shadowPerf.avg_pnl,
      best_trade: shadowPerf.trades.length > 0 ? Math.max(...shadowPerf.trades.map(t => t.hypothetical_pnl || 0)) : 0,
      worst_trade: shadowPerf.trades.length > 0 ? Math.min(...shadowPerf.trades.map(t => t.hypothetical_pnl || 0)) : 0,
      trades: shadowPerf.trades.slice(-10).reverse(),
    },
    autoresearch: researchStatus ? {
      crypto_params: researchStatus.crypto_params,
      polymarket_params: researchStatus.polymarket_params,
      recent_experiments: researchStatus.recent_experiments.slice(-5),
      crypto_history_count: researchStatus.crypto_history_count,
      polymarket_history_count: researchStatus.polymarket_history_count,
    } : null,
    signal_quality: await (async () => {
      try {
        const scores = await bankr.getSignalQuality();
        return scores.map(s => ({
          source: s.source,
          asset_class: s.asset_class,
          win_rate: s.win_rate,
          wins: s.wins,
          losses: s.losses,
          total_pnl: s.total_pnl,
          avg_pnl: s.avg_pnl,
          sample_size: s.recent_results.length,
          modifier: bankr.getSignalQualityModifier(scores, s.source, s.asset_class).modifier,
        }));
      } catch { return []; }
    })(),
    agent_activity: agentActivity,
    health: {
      kill_switch: summary.kill_switch,
      paused: summary.paused,
      mode: summary.mode,
      scout_last_run: scoutLastRun,
      scout_healthy: scoutHealthy,
      monitor_last_tick: monitorLastTick,
      monitor_healthy: monitorHealthy,
      oversight_last_run: oversightLastRun,
      oversight_healthy: oversightHealthy,
      deadman_healthy: monitorHealthy,
      bnkr_configured: summary.bnkr_configured,
    },
  };
}

app.get("/api/wealth-engines/data", async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query.force === "1";
    if (!forceRefresh && weDashboardCache && Date.now() - weDashboardCache.ts < WE_DASHBOARD_TTL) {
      res.json(weDashboardCache.data);
      return;
    }
    const data = await buildWealthEnginesDashboardData();
    weDashboardCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err: any) {
    console.error("[wealth-engines] dashboard data error:", err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

const WE_CONTROL_USERS = new Set(["rickin", "darknode"]);

app.post("/api/wealth-engines/pause", async (req: Request, res: Response) => {
  if (!WE_CONTROL_USERS.has((req as any).user)) { res.status(403).json({ error: "Forbidden" }); return; }
  try {
    const pool = (await import("./src/db.js")).getPool();
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    weDashboardCache = null;
    res.json({ ok: true, paused: true });
  } catch (err: any) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/wealth-engines/resume", async (req: Request, res: Response) => {
  if (!WE_CONTROL_USERS.has((req as any).user)) { res.status(403).json({ error: "Forbidden" }); return; }
  try {
    const pool = (await import("./src/db.js")).getPool();
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(false), Date.now()]
    );
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_kill_switch', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(false), Date.now()]
    );
    weDashboardCache = null;
    res.json({ ok: true, paused: false, kill_switch: false });
  } catch (err: any) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/wealth-engines/kill", async (req: Request, res: Response) => {
  if (!WE_CONTROL_USERS.has((req as any).user)) { res.status(403).json({ error: "Forbidden" }); return; }
  try {
    const pool = (await import("./src/db.js")).getPool();
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_kill_switch', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    weDashboardCache = null;
    res.json({ ok: true, kill_switch: true });
  } catch (err: any) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/wealth-engine/config", async (req: Request, res: Response) => {
  if (!WE_CONTROL_USERS.has((req as any).user)) { res.status(403).json({ error: "Forbidden" }); return; }
  try {
    const config = await bankr.getRiskConfig();
    const portfolio = await bankr.getPortfolioValue();
    const peak = await bankr.getPeakPortfolioValue();
    const mode = await bankr.getMode();
    const paused = await bankr.isPaused();
    const killSwitch = await bankr.isKillSwitchActive();
    const positions = await bankr.getPositions();
    const pool = db.getPool();
    let bootTime = 0;
    try {
      const bt = await pool.query(`SELECT value FROM app_config WHERE key = 'system_boot_time'`);
      if (bt.rows.length > 0) bootTime = typeof bt.rows[0].value === "number" ? bt.rows[0].value : 0;
    } catch {}
    let monitorTick = 0;
    try {
      const mt = await pool.query(`SELECT value FROM app_config WHERE key = 'bankr_monitor_last_tick'`);
      if (mt.rows.length > 0) monitorTick = typeof mt.rows[0].value === "number" ? mt.rows[0].value : 0;
    } catch {}
    let shadowOpen = 0, shadowClosed = 0;
    try {
      const { getShadowTrades } = await import("./src/oversight.js");
      const openShadows = await getShadowTrades("open");
      const closedShadows = await getShadowTrades("closed");
      shadowOpen = openShadows.length;
      shadowClosed = closedShadows.length;
    } catch {}
    const weJobs = scheduledJobs.getJobs().filter((j: any) =>
      ["scout-micro-scan", "scout-full-cycle", "polymarket-activity-scan", "polymarket-full-cycle", "bankr-execute", "oversight-health", "oversight-weekly", "oversight-daily-summary", "oversight-shadow-refresh", "autoresearch-weekly"].includes(j.id)
    ).map((j: any) => ({
      id: j.id, name: j.name, enabled: j.enabled,
      schedule_type: j.schedule.type,
      interval_minutes: j.schedule.intervalMinutes || null,
      hour: j.schedule.hour ?? null, minute: j.schedule.minute ?? null,
      last_run: j.lastRun || null, last_status: j.lastStatus || null,
    }));
    res.json({
      risk: config, portfolio, peak, mode, paused, kill_switch: killSwitch,
      bnkr_configured: (await import("./src/bnkr.js")).isConfigured(),
      positions_count: positions.length,
      boot_time: bootTime, monitor_tick: monitorTick,
      shadow_open: shadowOpen, shadow_closed: shadowClosed,
      jobs: weJobs,
    });
  } catch (err: any) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/wealth-engine/config", async (req: Request, res: Response) => {
  if (!WE_CONTROL_USERS.has((req as any).user)) { res.status(403).json({ error: "Forbidden" }); return; }
  try {
    const updates = req.body;
    if (!updates || typeof updates !== "object") { res.status(400).json({ error: "Body must be a JSON object" }); return; }
    const allowed = ["max_leverage", "risk_per_trade_pct", "max_positions", "exposure_cap_pct", "correlation_limit", "circuit_breaker_7d_pct", "circuit_breaker_drawdown_pct", "notification_mode"];
    const filtered: any = {};
    for (const k of Object.keys(updates)) {
      if (allowed.includes(k)) filtered[k] = updates[k];
    }
    if (Object.keys(filtered).length === 0) { res.status(400).json({ error: "No valid config keys provided" }); return; }
    const result = await bankr.setRiskConfig(filtered);
    if (filtered.notification_mode) {
      const pool = db.getPool();
      await pool.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        ["we_notification_mode", JSON.stringify(filtered.notification_mode), Date.now()]
      );
    }
    weDashboardCache = null;
    res.json({ ok: true, config: result });
  } catch (err: any) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.post("/api/wealth-engine/portfolio", async (req: Request, res: Response) => {
  if (!WE_CONTROL_USERS.has((req as any).user)) { res.status(403).json({ error: "Forbidden" }); return; }
  try {
    const { value, reset_peak } = req.body;
    const pool = db.getPool();
    if (typeof value === "number" && value > 0) {
      await pool.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        ["wealth_engines_portfolio_value", JSON.stringify(value), Date.now()]
      );
    }
    if (reset_peak) {
      const currentPortfolio = await bankr.getPortfolioValue();
      await pool.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        ["wealth_engines_peak_portfolio", JSON.stringify(currentPortfolio), Date.now()]
      );
    }
    weDashboardCache = null;
    res.json({ ok: true, portfolio: await bankr.getPortfolioValue(), peak: await bankr.getPeakPortfolioValue() });
  } catch (err: any) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/wealth-engine/mode", async (req: Request, res: Response) => {
  if (!WE_CONTROL_USERS.has((req as any).user)) { res.status(403).json({ error: "Forbidden" }); return; }
  try {
    const { mode } = req.body;
    if (!["SHADOW", "LIVE", "BETA"].includes(mode)) { res.status(400).json({ error: "Invalid mode" }); return; }
    const pool = db.getPool();
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      ["wealth_engines_mode", JSON.stringify(mode), Date.now()]
    );
    weDashboardCache = null;
    res.json({ ok: true, mode });
  } catch (err: any) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/wealth-engine/jobs/:jobId", async (req: Request, res: Response) => {
  if (!WE_CONTROL_USERS.has((req as any).user)) { res.status(403).json({ error: "Forbidden" }); return; }
  const WE_JOB_IDS = new Set(["scout-micro-scan", "scout-full-cycle", "polymarket-activity-scan", "polymarket-full-cycle", "bankr-execute", "oversight-health", "oversight-weekly", "oversight-daily-summary", "oversight-shadow-refresh", "autoresearch-weekly"]);
  try {
    const { jobId } = req.params;
    if (!WE_JOB_IDS.has(jobId)) { res.status(403).json({ error: "Not a Wealth Engine job" }); return; }
    const { enabled, interval_minutes } = req.body;
    const updates: any = {};
    if (typeof enabled === "boolean") updates.enabled = enabled;
    if (typeof interval_minutes === "number" && interval_minutes >= 5) {
      updates.schedule = { intervalMinutes: interval_minutes };
    }
    const result = scheduledJobs.updateJob(jobId, updates);
    if (!result) { res.status(404).json({ error: "Job not found" }); return; }
    res.json({ ok: true, job: { id: result.id, name: result.name, enabled: result.enabled, schedule: result.schedule } });
  } catch (err: any) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/x-intelligence/data", async (_req: Request, res: Response) => {
  try {
    const forceRefresh = _req.query.force === "1";
    if (!forceRefresh && xIntelCache && Date.now() - xIntelCache.ts < X_INTEL_TTL) {
      res.json(xIntelCache.data);
      return;
    }
    const data = await fetchXIntelData();
    xIntelCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err: any) {
    console.error("[x-intelligence] Error:", err);
    res.status(500).json({ error: "Failed to fetch X intelligence data" });
  }
});

app.get("/api/daily-brief/data", async (_req: Request, res: Response) => {
  try {
    const forceRefresh = _req.query.force === "1";
    if (!forceRefresh && dailyBriefCache && Date.now() - dailyBriefCache.ts < DAILY_BRIEF_TTL) {
      res.json(dailyBriefCache.data);
      return;
    }

    const cfg = alerts.getConfig();
    const tz = cfg.timezone || "America/New_York";
    const loc = cfg.location || "10016";
    const now = new Date();
    const result: any = {
      timestamp: now.toISOString(),
      greeting: "",
      date: "",
      welcomeMessage: "",
      weather: null,
      commuteAlert: null,
      markets: [],
      tasks: [],
      calendars: { rickin: [], pooja: [], reya: [], other: [] },
      headlines: [],
      xIntel: null,
      familyCards: [],
      baby: null,
      reya: null,
      moodys: null,
      realEstate: null,
      focusToday: null,
      jobs: null,
    };

    try {
      const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
      result.greeting = etHour < 12 ? "Good morning" : etHour < 17 ? "Good afternoon" : "Good evening";
      result.date = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" });
      result.timeStr = now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
    } catch {}

    const promises: Promise<void>[] = [];

    promises.push((async () => {
      try {
        const raw = await weather.getWeather(loc, 5);
        const tempMatch = raw.match(/Temperature:\s*([\d.-]+)°C\s*\((-?\d+)°F\)/);
        const condMatch = raw.match(/Condition:\s*(.+)/);
        const feelsMatch = raw.match(/Feels like:\s*([\d.-]+)°C\s*\((-?\d+)°F\)/);
        const humMatch = raw.match(/Humidity:\s*(\d+)%/);
        const windMatch = raw.match(/Wind:\s*(.+)/);
        if (tempMatch && condMatch) {
          const condition = condMatch[1].trim();
          const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
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
          const w: any = { tempC: Math.round(parseFloat(tempMatch[1])), tempF: parseInt(tempMatch[2]), condition, icon };
          if (feelsMatch) { w.feelsLikeC = Math.round(parseFloat(feelsMatch[1])); w.feelsLikeF = parseInt(feelsMatch[2]); }
          if (humMatch) w.humidity = parseInt(humMatch[1]);
          if (windMatch) w.wind = windMatch[1].trim();
          const forecastLines = raw.match(/\d{4}-\d{2}-\d{2}:\s*.+/g);
          if (forecastLines) {
            w.forecast = forecastLines.map((line: string) => {
              const m = line.match(/(\d{4}-\d{2}-\d{2}):\s*(.+?),\s*([\d-]+)-([\d-]+)°C.*?Rain:\s*(\d+)%/);
              if (!m) return null;
              const lowC = parseInt(m[3]), highC = parseInt(m[4]);
              return { date: m[1], condition: m[2].trim(), lowC, highC, lowF: Math.round(lowC * 9/5 + 32), highF: Math.round(highC * 9/5 + 32), rainPct: parseInt(m[5]) };
            }).filter(Boolean);
          }
          const hourlyPrecip = raw.match(/Hourly Precipitation:\n([\s\S]*?)(?:\n\d+-Day|\n$|$)/);
          if (hourlyPrecip) {
            const lines = hourlyPrecip[1].match(/\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):\s*(\d+)%/g) || [];
            for (const line of lines) {
              const m = line.match(/T(\d{2}):(\d{2}):\s*(\d+)%/);
              if (m) {
                const hour = parseInt(m[1]);
                const minute = parseInt(m[2]);
                const pct = parseInt(m[3]);
                const timeMinutes = hour * 60 + minute;
                if (timeMinutes >= 450 && timeMinutes <= 540 && pct > 40) {
                  const cond = (w.condition || "").toLowerCase();
                  const label = (cond.includes("snow") || cond.includes("sleet")) ? "snow" : "rain";
                  const timeLabel = hour > 12 ? `${hour - 12}:${m[2]} PM` : `${hour}:${m[2]} AM`;
                  result.commuteAlert = `☂️ ${pct}% chance of ${label} at school drop-off (~${timeLabel})`;
                  break;
                }
              }
            }
          }
          result.weather = w;
        }
      } catch {}
    })());

    const watchlistSymbols = [
      { symbol: "BTCUSD", type: "crypto" as const, display: "BTC", emoji: "₿" },
      { symbol: "MSTR", type: "stock" as const, display: "MSTR", emoji: "📊" },
      { symbol: "^GSPC", type: "stock" as const, display: "SPX", emoji: "📈" },
      { symbol: "GC=F", type: "stock" as const, display: "GOLD", emoji: "🥇" },
      { symbol: "SI=F", type: "stock" as const, display: "SILVER", emoji: "🥈" },
      { symbol: "CL=F", type: "stock" as const, display: "OIL", emoji: "🛢️" },
    ];
    promises.push((async () => {
      const quotePromises = watchlistSymbols.map(async (w) => {
        const q = await fetchQuoteStructured(w.symbol, w.type);
        if (q) return { ...q, display: w.display, emoji: w.emoji, type: w.type };
        return null;
      });
      const quotes = await Promise.all(quotePromises);
      result.markets = quotes.filter(Boolean);
    })());

    promises.push((async () => {
      try {
        const active = await tasks.getActiveTasks();
        result.tasks = active.slice(0, 8);
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
          const events = await calendar.listEventsStructured({ maxResults: 15, timeMax: endOfTomorrowUTC.toISOString() });
          const cals: any = { rickin: [], pooja: [], reya: [], other: [] };
          for (const ev of events) {
            const calName = (ev.calendar || "").toLowerCase();
            if (calName.includes("rickin") || calName.includes("primary") || calName === "" || calName.includes("rickin.patel")) cals.rickin.push(ev);
            else if (calName.includes("pooja")) cals.pooja.push(ev);
            else if (calName.includes("reya")) cals.reya.push(ev);
            else cals.other.push(ev);
          }
          result.calendars = cals;
        } catch {}
      })());
    }

    promises.push((async () => {
      try {
        if (xIntelCache && Date.now() - xIntelCache.ts < X_INTEL_TTL) {
          result.xIntel = xIntelCache.data;
        } else {
          const xData = await fetchXIntelData();
          xIntelCache = { data: xData, ts: Date.now() };
          result.xIntel = xData;
        }
      } catch {}
    })());

    promises.push((async () => {
      try {
        const [globalHeadlines, nycHeadlines] = await Promise.all([
          news.getTopHeadlines(8),
          news.searchHeadlines("New York City", 5),
        ]);
        const globalTagged = globalHeadlines.map(h => ({ ...h, category: "global" as const }));
        const nycTagged = nycHeadlines.map(h => ({ ...h, category: "nyc" as const }));
        const seen = new Set<string>();
        const deduped: typeof globalTagged = [];
        for (const h of [...globalTagged, ...nycTagged]) {
          const key = h.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(h);
          }
        }
        result.headlines = deduped;
      } catch {
        result.headlines = [];
      }
    })());

    promises.push((async () => {
      try {
        const dueDate = new Date("2026-07-07");
        const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
        const weeksPregnant = 40 - Math.ceil(daysLeft / 7);
        let nextAppt: any = null;
        if (gmail.isConnected()) {
          try {
            const readTab = async (range: string): Promise<string> => {
              try {
                const r = await gws.sheetsRead(BABY_SHEET_ID, range);
                if (r.includes("Error") || r.includes("not connected")) return "";
                return r;
              } catch { return ""; }
            };
            const apptResult = await readTab("Appointments!A1:E14");
            if (apptResult && !apptResult.includes("No data")) {
              const apptRows = apptResult.split("\n").filter(l => l.startsWith("Row ")).map(l => l.replace(/^Row \d+: /, "").split(" | "));
              const today = now.toISOString().split("T")[0];
              for (let i = 1; i < apptRows.length; i++) {
                const r = apptRows[i];
                const date = (r[0] || "").trim();
                if (date && date >= today) {
                  nextAppt = { date, title: (r[1] || "").trim() };
                  break;
                }
              }
            }
          } catch {}
        }
        result.baby = { weeksPregnant, daysLeft, nextAppt };
      } catch {}
    })());

    promises.push((async () => {
      try {
        const dayName = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
        const isWeekend = ["Saturday", "Sunday"].includes(dayName);
        if (!isWeekend) {
          const month = parseInt(now.toLocaleString("en-US", { timeZone: tz, month: "numeric" }));
          const day = parseInt(now.toLocaleString("en-US", { timeZone: tz, day: "numeric" }));
          let lunch = "Menu not available";
          try {
            const mealFile = await kbRead("Family/Reya's Education/Reya - School Meals.md");
            if (mealFile) {
              const datePattern = new RegExp(`\\|\\s*\\w+\\s+${month}/${day}\\s*\\|([^|]+)\\|([^|]+)\\|([^|]+)\\|`, "i");
              const match = mealFile.match(datePattern);
              if (match) {
                const mainDish = match[1].replace(/\*\*/g, "").trim();
                const vegStatus = match[2].trim();
                const sides = match[3].trim();
                const isVeg = vegStatus.includes("✅");
                lunch = isVeg ? `✅ ${mainDish}` : `❌ ${mainDish} — Sides: ${sides}`;
              }
            }
          } catch {}
          const etNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
          const pickupTime = new Date(etNow);
          pickupTime.setHours(16, 30, 0, 0);
          let pickupCountdown: string;
          if (etNow < pickupTime) {
            const diffMs = pickupTime.getTime() - etNow.getTime();
            const h = Math.floor(diffMs / 3600000);
            const m = Math.floor((diffMs % 3600000) / 60000);
            pickupCountdown = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
          } else {
            pickupCountdown = "✅ Picked up";
          }
          let schoolAlert: string | null = null;
          try {
            if (gmail.isConnected()) {
              const a = await gmail.searchEmailsStructured("from:kristen OR from:cicio is:unread newer_than:2d", 1);
              if (a.length > 0) schoolAlert = a[0].subject;
            }
          } catch {}
          result.reya = { schoolInSession: true, lunch, pickupCountdown, alert: schoolAlert };
        } else {
          result.reya = { schoolInSession: false, isWeekend: true };
        }
      } catch {}
    })());

    promises.push((async () => {
      try {
        const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
        const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
        const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
        const dateStr = `${year}-${month}-${day}`;
        const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
        let briefContent: string | null = null;
        let briefDate = dateStr;
        if (etHour >= 6) {
          try {
            const content = await kbRead(`Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Brief.md`);
            if (content && content.length > 100) briefContent = content;
          } catch {}
        }
        if (!briefContent) {
          const yesterday = new Date(now.getTime() - 86400000);
          const yDateStr = `${yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" })}`;
          try {
            const content = await kbRead(`Scheduled Reports/Moody's Intelligence/Daily/${yDateStr}-Brief.md`);
            if (content && content.length > 100) { briefContent = content; briefDate = yDateStr; }
          } catch {}
        }
        if (!briefContent) {
          result.moodys = { available: false, reason: etHour < 6 ? "pending" : "missing", message: etHour < 6 ? "Daily brief generates at 6:00 AM" : "Brief unavailable — check pipeline" };
          return;
        }
        const categories: Record<string, string[]> = { corporate: [], banking: [], competitors: [], aiTrends: [], analysts: [] };
        const MAX_PER_CAT = 5;

        const sectionMap: Array<{ pattern: RegExp; key: string }> = [
          { pattern: /^##\s+🏢\s+Moody/im, key: "corporate" },
          { pattern: /^##\s+🏦\s+Banking/im, key: "banking" },
          { pattern: /^##\s+🔍\s+Competitor/im, key: "competitors" },
          { pattern: /^##\s+🤖\s+Enterprise\s*AI/im, key: "aiTrends" },
          { pattern: /^##\s+📊\s+Industry\s*Analyst/im, key: "analysts" },
        ];
        const lines = briefContent.split("\n");
        let currentKey: string | null = null;
        for (const line of lines) {
          for (const { pattern, key } of sectionMap) {
            if (pattern.test(line)) { currentKey = key; break; }
          }
          if (/^##\s+⚡\s+Key\s+Takeaway/i.test(line) || /^##\s+🐦/i.test(line)) { currentKey = null; continue; }
          if (currentKey && /^-\s+.+/.test(line)) {
            if (categories[currentKey].length < MAX_PER_CAT) {
              let text = line.replace(/^-\s+/, "").replace(/🔴|🟡|🟢/g, "").replace(/\*\*/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
              if (text.length > 160) text = text.slice(0, 157) + "...";
              if (text) categories[currentKey].push(text);
            }
          }
        }

        let totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);

        if (totalItems === 0) {
          const catKeywords: Array<{ pattern: RegExp; key: string }> = [
            { pattern: /moody'?s\s*corporate/i, key: "corporate" },
            { pattern: /banking/i, key: "banking" },
            { pattern: /competitor/i, key: "competitors" },
            { pattern: /enterprise\s*ai/i, key: "aiTrends" },
            { pattern: /industry\s*analyst/i, key: "analysts" },
          ];
          const tableRows = briefContent.match(/^\|[^|]*\|[^|]*\|[^|]*\|/gm) || [];
          for (const row of tableRows) {
            const cells = row.split("|").map(c => c.trim()).filter(Boolean);
            if (cells.length < 3 || /^[#-]+$/.test(cells[0])) continue;
            const item = cells[1].replace(/\*\*/g, "").replace(/\(?\[.*?\]\(.*?\)\)?/g, "").trim();
            const catCell = cells[2];
            if (!item || !catCell || /^Category$/i.test(catCell) || /^-+$/.test(catCell)) continue;
            for (const { pattern, key } of catKeywords) {
              if (pattern.test(catCell)) {
                if (categories[key].length < MAX_PER_CAT) {
                  const clean = item.length > 160 ? item.slice(0, 157) + "..." : item;
                  categories[key].push(clean);
                }
                break;
              }
            }
          }
          totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);
        }

        if (totalItems === 0) {
          const bullets = briefContent.match(/^- .+$/gm) || [];
          for (const b of bullets.slice(0, 5)) {
            let text = b.replace(/^- /, "").replace(/\*\*/g, "").trim();
            if (text.length > 160) text = text.slice(0, 157) + "...";
            categories.corporate.push(text);
          }
          totalItems = categories.corporate.length;
        }

        const takeaways = briefContent.match(/^\d+\.\s+\*\*.+$/gm) || [];
        if (totalItems === 0 && takeaways.length === 0) {
          result.moodys = { available: false, reason: "unstructured", message: "Brief format not recognized" };
          return;
        }
        const tsMatch = briefContent.match(/Generated:\s*(.+)/);
        result.moodys = { available: true, date: briefDate, categories, timestamp: tsMatch ? tsMatch[1].trim() : null };
      } catch {}
    })());

    promises.push((async () => {
      try {
        const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
        const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
        const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
        const dateStr = `${year}-${month}-${day}`;
        let scanContent: string | null = null;
        let scanDate = dateStr;
        try {
          const content = await kbRead(`Scheduled Reports/Real Estate/${dateStr}-Property-Scan.md`);
          if (content) scanContent = content;
        } catch {}
        if (!scanContent) {
          const yesterday = new Date(now.getTime() - 86400000);
          const yDateStr = `${yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" })}`;
          try {
            const content = await kbRead(`Scheduled Reports/Real Estate/${yDateStr}-Property-Scan.md`);
            if (content) { scanContent = content; scanDate = yDateStr; }
          } catch {}
        }
        if (scanContent) {
          const scannedMatch = scanContent.match(/\*\*(\d+)\+?\s*listings?\s*scanned\*\*/i);
          const totalListings = scannedMatch ? parseInt(scannedMatch[1]) : 0;
          const newMatch = scanContent.match(/\*\*(\d+)\s*new\s*listings?\*\*/i);
          const newListings = newMatch ? parseInt(newMatch[1]) : 0;
          const tsMatch = scanContent.match(/Generated:\s*(.+)/);
          result.realEstate = { available: true, date: scanDate, totalListings, newListings, scanTime: tsMatch ? tsMatch[1].trim() : null };
        }
      } catch {}
    })());

    promises.push((async () => {
      try {
        const active = await tasks.getActiveTasks();
        const today = now.toISOString().split("T")[0];
        const urgent = active.filter((t: any) => t.priority === "high" || (t.dueDate && t.dueDate <= today));
        const urgentIds = new Set(urgent.map((t: any) => t.id));
        const rest = active.filter((t: any) => !urgentIds.has(t.id));
        const focusTasks = [...urgent, ...rest].slice(0, 3);
        let actionEmails: any[] = [];
        let actionCount = 0;
        try {
          if (gmail.isConnected()) {
            const [emails, countResult] = await Promise.all([
              gmail.searchEmailsStructured("label:Action-Required is:unread", 3),
              gmail.countUnread ? gmail.countUnread("label:Action-Required is:unread") : Promise.resolve(-1),
            ]);
            actionEmails = emails;
            actionCount = typeof countResult === "number" && countResult >= 0 ? countResult : emails.length;
          }
        } catch {}
        if (actionEmails.length > 0 && ANTHROPIC_KEY) {
          try {
            const { default: Anthropic } = await import("@anthropic-ai/sdk");
            const client = new Anthropic({ apiKey: ANTHROPIC_KEY, timeout: 5000 });
            const emailList = actionEmails.map((e: any, i: number) =>
              `[${i}] From: ${e.from} | Subject: ${e.subject}${e.snippet ? ` | Preview: ${e.snippet}` : ""}`
            ).join("\n");
            const response = await client.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 500,
              messages: [{ role: "user", content: `For each email below, write a brief action insight (max 12 words) describing what the recipient likely needs to do.\nFocus on the action: approve, reply, review, schedule, follow up, etc.\nReturn ONLY valid JSON array: [{\"index\":0,\"insight\":\"...\"}]\n\n${emailList}` }],
              system: "You are a concise executive assistant. Return ONLY a JSON array, no other text.",
            });
            const text = response.content.map((b: any) => b.type === "text" ? b.text : "").join("");
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const insights: Array<{ index: number; insight: string }> = JSON.parse(jsonMatch[0]);
              for (const ins of insights) {
                if (ins.index >= 0 && ins.index < actionEmails.length && ins.insight) {
                  const words = ins.insight.split(/\s+/);
                  actionEmails[ins.index].insight = words.length > 12 ? words.slice(0, 12).join(" ") : ins.insight;
                }
              }
            }
          } catch (err: any) {
            console.warn("[daily-brief] Email insight AI failed:", err.message);
          }
        }
        result.focusToday = { tasks: focusTasks, actionEmails, actionCount };
      } catch {}
    })());

    await Promise.all(promises);

    try {
      const etHourForCards = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
      const cals = result.calendars || { rickin: [], pooja: [], reya: [], other: [] };
      const familyCards: any[] = [];

      const rickinCard: any = { name: "Rickin", emoji: "\u{1F468}\u200D\u{1F4BB}", headline: "", subtext: "" };
      const rickinEvents = [...(cals.rickin || []), ...(cals.other || [])];
      if (etHourForCards < 12 && rickinEvents.length > 0) {
        const next = rickinEvents[0];
        rickinCard.headline = next.title || "Meeting";
        rickinCard.subtext = next.time || "";
      } else if (etHourForCards < 17 && result.focusToday) {
        const tc = result.focusToday.tasks?.length || 0;
        const ec = result.focusToday.actionCount || 0;
        rickinCard.headline = `${tc} task${tc !== 1 ? "s" : ""}, ${ec} email${ec !== 1 ? "s" : ""}`;
        rickinCard.subtext = "to action";
      } else if (rickinEvents.length > 0) {
        rickinCard.headline = rickinEvents[0].title || "Event tomorrow";
        rickinCard.subtext = rickinEvents[0].time || "";
      } else {
        rickinCard.headline = "";
        rickinCard.subtext = "";
      }
      familyCards.push(rickinCard);

      const poojaCard: any = { name: "Pooja", emoji: "\u{1F930}", headline: "", subtext: "" };
      if (result.baby) {
        if (etHourForCards < 12) {
          poojaCard.headline = `Week ${result.baby.weeksPregnant}`;
          poojaCard.subtext = `${result.baby.daysLeft} days to go`;
        } else if (result.baby.nextAppt) {
          poojaCard.headline = `Next appt: ${result.baby.nextAppt.date}`;
          poojaCard.subtext = result.baby.nextAppt.title || "";
        } else {
          poojaCard.headline = `Week ${result.baby.weeksPregnant}`;
          poojaCard.subtext = `${result.baby.daysLeft} days to go`;
        }
      }
      const poojaEvents = cals.pooja || [];
      if (!poojaCard.headline && poojaEvents.length > 0) {
        poojaCard.headline = poojaEvents[0].title || "Event";
        poojaCard.subtext = poojaEvents[0].time || "";
      }
      familyCards.push(poojaCard);

      const reyaCard: any = { name: "Reya", emoji: "\u{1F467}", headline: "", subtext: "" };
      if (result.reya && result.reya.schoolInSession) {
        if (etHourForCards < 12) {
          reyaCard.headline = result.reya.lunch || "School day";
          reyaCard.subtext = "Today's lunch";
        } else if (etHourForCards < 17) {
          reyaCard.headline = `Pickup ${result.reya.pickupCountdown}`;
          reyaCard.subtext = "4:30 PM";
        } else {
          reyaCard.headline = "School day done";
          reyaCard.subtext = result.reya.alert || "";
        }
      } else {
        const reyaEvents = cals.reya || [];
        if (reyaEvents.length > 0) {
          reyaCard.headline = reyaEvents[0].title || "Event";
          reyaCard.subtext = reyaEvents[0].time || "";
        } else if (result.reya && result.reya.isWeekend) {
          reyaCard.headline = "No school today!";
          reyaCard.subtext = "Enjoy the weekend!";
        }
      }
      familyCards.push(reyaCard);

      const needsTips = familyCards.filter((c: any) => !c.headline);
      if (needsTips.length > 0) {
        try {
          const tipPrompt = needsTips.map((c: any) => {
            if (c.name === "Rickin") return "A short productivity or market insight for a tech strategist";
            if (c.name === "Pooja") return `A pregnancy wellness tip for week ${result.baby?.weeksPregnant || 24}`;
            return "A fun fact or learning prompt for a 4-year-old girl";
          }).join("\n");
          const tipResp = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 200,
            messages: [{ role: "user", content: `Generate ${needsTips.length} micro-tips (one per line, max 40 chars each, no numbering, no quotes):\n${tipPrompt}` }],
          });
          const tips = (tipResp.content[0] as any).text.split("\n").filter((l: string) => l.trim());
          needsTips.forEach((c: any, i: number) => {
            c.headline = tips[i]?.trim().slice(0, 50) || "Have a great day!";
            c.subtext = "Daily tip";
          });
        } catch {
          needsTips.forEach((c: any) => { c.headline = "Have a great day!"; c.subtext = ""; });
        }
      }

      result.familyCards = familyCards;
    } catch {}

    try {
      const dayOfWeek = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
      const cals = result.calendars || { rickin: [], pooja: [], reya: [], other: [] };
      const eventCount = cals.rickin.length + cals.pooja.length + cals.reya.length + (cals.other || []).length;
      const taskCount = result.tasks ? result.tasks.length : 0;
      result.welcomeMessage = await generateWelcomeMessage({
        greeting: result.greeting,
        dayOfWeek,
        tempC: result.weather?.tempC ?? null,
        condition: result.weather?.condition ?? null,
        taskCount,
        eventCount,
        babyWeeks: result.baby?.weeksPregnant ?? null,
      });
    } catch {
      const dayOfWeek = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
      result.welcomeMessage = `${result.greeting}, Rickin. Here's your brief for ${dayOfWeek}.`;
    }

    const allJobs = scheduledJobs.getJobs();
    const enabledJobs = allJobs.filter((j: any) => j.enabled);
    const okCount = enabledJobs.filter((j: any) => j.lastStatus === "success").length;
    const failedCount = enabledJobs.filter((j: any) => j.lastStatus === "error").length;
    result.jobs = { total: enabledJobs.length, ok: okCount, failed: failedCount };
    result.nextJob = scheduledJobs.getNextJob();

    dailyBriefCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch daily brief data" });
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
        rickin: r[4]?.trim() || "",
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

  if (slug === "wealth-engines") {
    try {
      let html = fs.readFileSync(filePath, "utf-8");
      const data = await buildWealthEnginesDashboardData();
      const safeJson = JSON.stringify(data).replace(/<\//g, "<\\/");
      html = html.replace(
        "var SSR_DATA = null;",
        `var SSR_DATA = ${safeJson};`
      );
      res.type("html").send(html);
      return;
    } catch (err) {
      console.error("[wealth-engines] SSR error:", err);
    }
  }

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
            currentWeekData = { week: parseInt(r[0]) || 0, development: (r[3] || "").trim(), rickin: (r[4] || "").trim() };
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

app.post("/api/pages/:slug/share", async (req: Request, res: Response) => {
  const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!["daily-brief", "baby-dashboard", "x-intelligence", "wealth-engines"].includes(slug)) {
    res.status(400).json({ error: "Sharing not supported for this page" });
    return;
  }

  try {
    const filePath = path.join(PAGES_DIR, `${slug}.html`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }

    let html = fs.readFileSync(filePath, "utf-8");
    const now = new Date();
    const cfg = alerts.getConfig();
    const tz = cfg.timezone || "America/New_York";
    const snapTime = now.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    const titleDate = now.toLocaleDateString("en-US", { timeZone: tz, month: "long", day: "numeric", year: "numeric" });

    if (slug === "daily-brief") {
      let data: any = dailyBriefCache?.data;
      if (!data) {
        try {
          const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/daily-brief/data?user=darknode&token=${encodeURIComponent(process.env.APP_PASSWORD || "")}`);
          if (resp.ok) data = await resp.json();
        } catch {}
      }
      if (!data) {
        res.status(500).json({ error: "Could not fetch daily brief data" });
        return;
      }
      const dataJson = JSON.stringify(data);
      html = html.replace(
        /fetchData\(\);\s*setInterval\(fetchData,\s*\d+\);/,
        `var SNAPSHOT_DATA = ${dataJson};\nrender(SNAPSHOT_DATA);`
      );
      html = html.replace(/<button[^>]*onclick="fetchData\(true\)"[^>]*>Refresh<\/button>/g, "");
    } else if (slug === "baby-dashboard") {
      if (gmail.isConnected()) {
        try {
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
          const apptJson = JSON.stringify(appointments);
          const tasksJson = JSON.stringify(tasks);
          const checklistJson = JSON.stringify({ shoppingDone: `${shoppingDone}/${shoppingItems.length}`, tasksDone: `${tasksDone}/${tasks.length}` });
          html = html.replace(/<script id="appt-data"[^>]*>.*?<\/script>/s, `<script id="appt-data" type="application/json">${apptJson}</script>`);
          html = html.replace(/<script id="tasks-data"[^>]*>.*?<\/script>/s, `<script id="tasks-data" type="application/json">${tasksJson}</script>`);
          html = html.replace(/<script id="checklist-data"[^>]*>.*?<\/script>/s, `<script id="checklist-data" type="application/json">${checklistJson}</script>`);
          const timelineRows = parseRows(timelineResult);
          let currentWeekData: any = null;
          timelineRows.slice(1).forEach(r => {
            const status = (r[5] || "").trim();
            if (status.includes("✅") && status.toLowerCase().includes("current")) {
              currentWeekData = { week: parseInt(r[0]) || 0, development: (r[3] || "").trim(), rickin: (r[4] || "").trim() };
            }
          });
          if (currentWeekData) {
            html = html.replace(/id="devNote">[^<]*</s, `id="devNote">${currentWeekData.development}<`);
          }
          const nameRows = parseRows(namesResult);
          const favNames: any[] = [], otherNames: any[] = [];
          nameRows.slice(1).filter(r => r[0]).forEach(r => {
            const n = (r[0] || "").trim();
            if (n === "⭐ FAVORITES" || n === "📋 SHORTLIST" || !n) return;
            const entry = { name: n, meaning: (r[1] || "").trim() };
            if ((r[3] || "").includes("⭐") || (r[3] || "").includes("🆕") || (r[4] || "").includes("⭐")) favNames.push(entry);
            else otherNames.push(entry);
          });
          if (favNames.length) {
            const favStr = favNames.map(n => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${n.meaning.replace(/'/g, "\\'")}'}`).join(",");
            html = html.replace(/var defaultFavNames\s*=\s*\[.*?\];/s, `var defaultFavNames = [${favStr}];`);
          }
          if (otherNames.length) {
            const otherStr = otherNames.map(n => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${n.meaning.replace(/'/g, "\\'")}'}`).join(",");
            html = html.replace(/var defaultOtherNames\s*=\s*\[.*?\];/s, `var defaultOtherNames = [${otherStr}];`);
          }
        } catch (err) {
          console.error("[share] baby-dashboard SSR error:", err);
        }
      }
      html = html.replace(/fetchLiveData\(\);\s*setInterval\(fetchLiveData,\s*\d+\);/,
        "// snapshot mode - no live fetching");
      html = html.replace(/\(async function loadUser\(\)[\s\S]*?\}\)\(\);/, "// snapshot mode");
    } else if (slug === "wealth-engines") {
      try {
        const weData = await buildWealthEnginesDashboardData();
        const safeJson = JSON.stringify(weData).replace(/<\//g, "<\\/");
        html = html.replace(
          "var SSR_DATA = null;",
          `var SSR_DATA = ${safeJson};`
        );
      } catch (err) {
        console.error("[share] wealth-engines data error:", err);
      }
      html = html.replace(/setInterval\(function\(\)\s*\{\s*fetchData\(\);\s*\}\s*,\s*\d+\);/, "");
      html = html.replace(/id="refreshBtn"[^>]*>[^<]*<\/button>/g, 'id="refreshBtn" style="display:none"></button>');
      html = html.replace(/id="shareBtn"[^>]*>[^<]*<\/button>/g, 'id="shareBtn" style="display:none"></button>');
      html = html.replace(/id="shareModal"/, 'id="shareModal" style="display:none !important"');
    } else if (slug === "x-intelligence") {
      let xData: any = xIntelCache?.data || dailyBriefCache?.data?.xIntel;
      if (!xData) {
        try {
          xData = await fetchXIntelData();
          xIntelCache = { data: xData, ts: Date.now() };
        } catch {}
      }
      if (!xData) {
        res.status(500).json({ error: "Could not fetch X intelligence data" });
        return;
      }
      const dataJson = JSON.stringify(xData);
      html = html.replace(
        /fetchData\(\);\s*setInterval\(fetchData,\s*\d+\);/,
        `var SNAPSHOT_DATA = ${dataJson};\nrender(SNAPSHOT_DATA);`
      );
      html = html.replace(/<button[^>]*onclick="fetchData\(true\)"[^>]*>Refresh<\/button>/g, "");
    }

    html = html.replace(/<div class="share-btn-wrap">.*?<\/div>/gs, "");
    html = html.replace(/<div class="share-overlay"[^]*?<!-- \/share-overlay -->/g, "");
    html = html.replace(/function shareSnapshot\(\)[^]*?function copyShareUrl\(\)[^]*?\n\}/g, "");

    const snapshotFooter = `<div style="text-align:center;color:#555;font-size:0.65rem;padding:1.5rem 1rem 2rem;line-height:1.6;font-family:-apple-system,sans-serif;">
      <div style="margin-bottom:2px;">📸 Snapshot · ${snapTime}</div>
      <div style="color:#444;">This link expires in 24 hours</div>
    </div>`;
    html = html.replace(/<\/body>/, `${snapshotFooter}\n</body>`);

    const tmpFile = `/tmp/snapshot-${slug}-${Date.now()}.html`;
    fs.writeFileSync(tmpFile, html);

    const publishScript = path.join(PROJECT_ROOT, "scripts", "herenow-publish.sh");
    const titleStr = slug === "daily-brief" ? `Daily Brief — ${titleDate}` : slug === "x-intelligence" ? `X Intelligence — ${titleDate}` : `Baby Dashboard — ${titleDate}`;
    const output = execSync(`bash "${publishScript}" "${tmpFile}" --title "${titleStr}" --client "darknode"`, {
      encoding: "utf-8",
      timeout: 30000,
    });

    try { fs.unlinkSync(tmpFile); } catch {}

    const lines = output.trim().split("\n");
    const url = lines[0]?.trim();
    if (!url || !url.startsWith("http")) {
      res.status(500).json({ error: "Failed to publish snapshot" });
      return;
    }

    console.log(`[share] Published ${slug} snapshot: ${url}`);
    res.json({ url, expiresIn: "24h" });
  } catch (err: any) {
    console.error("[share] Error:", err);
    res.status(500).json({ error: err.message || "Failed to generate snapshot" });
  }
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
  ...buildImageTools(),
  ...buildRenderPageTools(),
  ...buildTaskTools(),
  ...buildNewsTools(),
  ...buildTwitterTools(),
  ...buildStockTools(),
  ...buildCoinGeckoTools(),
  ...buildSignalSourceTools(),
  ...buildMapsTools(),
  ...buildDriveTools(),
  ...buildSheetsTools(),
  ...buildDocsTools(),
  ...buildSlidesTools(),
  ...buildYouTubeTools(),
  ...buildRealEstateTools(),
  ...buildConversationTools(),
  ...buildMemoryTools(),
  ...buildWebPublishTools(),
  ...buildOversightTools(),
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
      planningMode: false,
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
        const toolName = (event as any).toolName || null;
        if (toolName === "delegate" && (event as any).input) {
          const agentId = (event as any).input.agent || "";
          entry.currentToolName = `delegate:${agentId}`;
          (event as any).toolInput = { agent: agentId };
        } else {
          entry.currentToolName = toolName;
        }
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

      let hindsightContext: string | null = null;
      if (hindsight.isConfigured()) {
        try {
          const memResult = await hindsight.recall({ query: "What has Rickin been working on and talking about recently? Important decisions, preferences, and context.", topK: 8 });
          if (memResult.memories.length > 0) {
            const memLines = memResult.memories.map(m => `- ${m.text}`).join("\n");
            hindsightContext = `[Long-term Memory Context]\nRelevant memories from past sessions:\n${memLines}`;
          }
        } catch (err) {
          console.warn("[session] Hindsight recall for greeting failed:", err);
        }
      }

      combinedContext = [lastConvoContext, recentSummary, hindsightContext, vaultIndex].filter(Boolean).join("\n\n---\n\n") || null;
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
    if (entry.subscribers.size === 0 && entry.isAgentRunning && entry.currentAgentText) {
      console.log(`[sse] All subscribers dropped while agent running — saving partial text (${entry.currentAgentText.length} chars)`);
      conversations.addMessage(entry.conversation, "agent", entry.currentAgentText + "\n\n⚠️ *Connection dropped — response may be incomplete. Ask me to continue if needed.*");
      entry.currentAgentText = "";
      conversations.save(entry.conversation).catch(err => console.error("[conversations] partial save error:", err));
    }
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
  if (entry.planningMode) {
    augmentedText += `[PLANNING MODE] Before taking any action or calling any tools, you must first present a clear, numbered plan of what you intend to do. Explain each step briefly. Then ask for my approval before proceeding. Do NOT execute any tools or actions until I explicitly confirm the plan (e.g. "go ahead", "yes", "approved", "do it"). If I ask you to modify the plan, revise it and ask for approval again.\n\n`;
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

app.put("/api/session/:id/planning-mode", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" }); return;
  }
  entry.planningMode = enabled;
  console.log(`[planning] Session ${req.params["id"]} planning mode: ${enabled}`);
  res.json({ ok: true, planningMode: enabled });
});

app.get("/api/session/:id/planning-mode", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }
  res.json({ planningMode: entry.planningMode });
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

app.get("/api/agents/status", async (_req: Request, res: Response) => {
  const runningJob = scheduledJobs.getRunningJob();
  const activeSessions: { id: string; running: boolean; tool?: string; conversationId?: string; conversationTitle?: string }[] = [];
  for (const [id, entry] of sessions.entries()) {
    if (entry.isAgentRunning) {
      activeSessions.push({
        id,
        running: true,
        tool: entry.currentToolName || undefined,
        conversationId: entry.conversation?.id,
        conversationTitle: entry.conversation?.title,
      });
    }
  }
  let recentCompletions: any[] = [];
  try {
    const pool = db.getPool();
    const result = await pool.query(`SELECT agent, task, conversation_id, conversation_title, duration_ms, saved_to, created_at FROM agent_activity ORDER BY created_at DESC LIMIT 5`);
    recentCompletions = result.rows.map(r => ({
      timestamp: Number(r.created_at),
      agent: r.agent,
      task: r.task,
      conversationId: r.conversation_id,
      conversationTitle: r.conversation_title,
      duration: r.duration_ms,
      savedTo: r.saved_to,
    }));
  } catch (e: any) { console.warn("[agent_activity] DB query failed:", e.message); }
  res.json({
    job: runningJob,
    sessions: activeSessions,
    anyActive: runningJob.running || activeSessions.length > 0,
    recentCompletions,
  });
});

app.post("/api/vault-inbox", async (req: Request, res: Response) => {
  const { url, tag, source } = req.body as { url?: string; tag?: string; source?: string };
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "URL is required" });
    return;
  }
  try {
    new URL(url);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  const pool = db.getPool();

  try {
    const existing = await pool.query(`SELECT id, title, file_path, tags, status, created_at FROM vault_inbox WHERE url = $1`, [url]);
    if (existing.rows.length > 0 && existing.rows[0].status === "filed") {
      const row = existing.rows[0];
      res.json({
        status: "duplicate",
        title: row.title,
        filePath: row.file_path,
        tags: row.tags || [],
        filedAt: Number(row.created_at),
      });
      return;
    }
  } catch {}

  const now = Date.now();
  let inboxId: number;
  try {
    const ins = await pool.query(
      `INSERT INTO vault_inbox (url, source, status, created_at) VALUES ($1, $2, 'processing', $3) ON CONFLICT (url) DO UPDATE SET status = 'processing', created_at = $3 RETURNING id`,
      [url, source || "drop-box", now]
    );
    inboxId = ins.rows[0].id;
  } catch (e: any) {
    res.status(500).json({ error: "Database error" });
    return;
  }

  res.json({ status: "processing", id: inboxId });

  let linkType = "article";
  if (/youtube\.com\/watch|youtu\.be\//i.test(url)) linkType = "youtube";
  else if (/twitter\.com|x\.com/i.test(url)) linkType = "tweet";
  else if (/github\.com/i.test(url)) linkType = "github";

  const tagHint = tag ? `\nIMPORTANT: The user tagged this as "${tag}" — use this to determine the vault folder.` : "";

  const taskPrompt = `Extract and file content from this URL into the knowledge base vault.

URL: ${url}
Link type: ${linkType}
${tagHint}

Instructions:
1. Use the appropriate tool to extract content:
   - YouTube: use youtube_video to get title, channel, description
   - Tweet: use x_read_tweet to get tweet content
   - Article/GitHub: try web_fetch first. If the content is empty, incomplete, or clearly truncated (e.g. just nav/footer text), retry with render_page which uses a full cloud browser with anti-bot protection to get the real page content
2. Determine the best vault folder based on content topic:
   - Moody's / competitor / banking / work → Projects/Moody's/Competitive Intelligence/
   - Consciousness / spirituality / health → Health/
   - Real estate / housing → Real Estate/
   - AI / tech / agentic systems → Resources/AI Education/
   - Finance / markets / investing → Finances/
   - Career / professional → Career Development/
   - General reference → Resources/
3. Create a structured note using notes_create with this format:
   - Frontmatter: source, type (${linkType}), author/speaker, date_filed (today), tags
   - Title heading
   - Summary (2-3 sentences)
   - Key Takeaways (3-5 bullets)
   - Frameworks/Models (if applicable, use [[wikilinks]])
   - Related Vault Nodes (if applicable, use [[wikilinks]])
   - Footer: "Filed via: Vault Inbox"
4. Filename: use format "{YYYY-MM-DD} - {Cleaned Title}.md" in the chosen folder

IMPORTANT: After filing, respond with EXACTLY this format on the FIRST LINE of your response:
FILED|{title}|{full/vault/path.md}|{comma,separated,tags}

Then add a brief summary below.`;

  try {
    const agentTools = [
      ...buildKnowledgeBaseTools(),
      ...cachedStaticTools,
    ];
    const result = await runSubAgent({
      agentId: "knowledge-organizer",
      task: taskPrompt,
      allTools: agentTools as any,
      apiKey: ANTHROPIC_KEY,
    });

    let title = "";
    let filePath = "";
    let tags: string[] = [];
    let summary = result.response;

    const firstLine = result.response.split("\n")[0];
    if (firstLine.startsWith("FILED|")) {
      const parts = firstLine.split("|");
      title = parts[1] || "";
      filePath = parts[2] || "";
      tags = (parts[3] || "").split(",").map(t => t.trim()).filter(Boolean);
      summary = result.response.split("\n").slice(1).join("\n").trim();
    }

    await pool.query(
      `UPDATE vault_inbox SET title = $1, file_path = $2, tags = $3, summary = $4, status = 'filed' WHERE id = $5`,
      [title || "Untitled", filePath, JSON.stringify(tags), summary.slice(0, 500), inboxId]
    );

    try {
      const date = new Date().toISOString().slice(0, 16).replace("T", " ");
      const logLine = `- ${date} | ${linkType} | ${title || url} | → ${filePath}\n`;
      const logPath = "Resources/Vault-Inbox-Log.md";
      try {
        await kbAppend(logPath, logLine);
      } catch {
        await kbCreate(logPath, `# Vault Inbox Log\n\n${logLine}`);
      }
    } catch {}

    try {
      await pool.query(
        `INSERT INTO agent_activity (agent, task, saved_to, created_at) VALUES ($1, $2, $3, $4)`,
        ["knowledge-organizer", `Vault Inbox: ${title || url}`.slice(0, 200), filePath || null, Date.now()]
      );
    } catch {}

  } catch (err: any) {
    console.error("[vault-inbox] Processing failed:", err.message);
    await pool.query(
      `UPDATE vault_inbox SET status = 'error', error = $1 WHERE id = $2`,
      [err.message?.slice(0, 500) || "Unknown error", inboxId]
    );
  }
});

app.get("/api/vault-inbox/history", async (_req: Request, res: Response) => {
  try {
    const pool = db.getPool();
    const result = await pool.query(
      `SELECT id, url, title, file_path, tags, summary, source, status, error, created_at FROM vault_inbox ORDER BY created_at DESC LIMIT 10`
    );
    res.json(result.rows.map(r => ({
      id: r.id,
      url: r.url,
      title: r.title,
      filePath: r.file_path,
      tags: r.tags || [],
      summary: r.summary,
      source: r.source,
      status: r.status,
      error: r.error,
      createdAt: Number(r.created_at),
    })));
  } catch (err) {
    res.status(500).json({ error: "Failed to load history" });
  }
});

app.get("/api/vault-inbox/:id", async (req: Request, res: Response) => {
  try {
    const pool = db.getPool();
    const result = await pool.query(
      `SELECT id, url, title, file_path, tags, summary, source, status, error, created_at FROM vault_inbox WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const r = result.rows[0];
    res.json({
      id: r.id,
      url: r.url,
      title: r.title,
      filePath: r.file_path,
      tags: r.tags || [],
      summary: r.summary,
      source: r.source,
      status: r.status,
      error: r.error,
      createdAt: Number(r.created_at),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load item" });
  }
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

app.get("/api/kb/read", async (req: Request, res: Response) => {
  try {
    const path = (req.query as any).path;
    if (!path) { res.status(400).json({ error: "path required" }); return; }
    const content = await kbRead(path);
    res.json({ content });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to read" });
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

app.get("/api/cost-summary", async (_req: Request, res: Response) => {
  try {
    const summary = await scheduledJobs.getCostSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/v1/models", (_req: Request, res: Response) => {
  res.json({
    object: "list",
    data: [
      { id: "claude-sonnet-4-6", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-haiku-4-5-20251001", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-opus-4-6", object: "model", created: 1700000000, owned_by: "anthropic" },
    ],
  });
});

app.post("/api/v1/chat/completions", async (req: Request, res: Response) => {
  try {
    if (!ANTHROPIC_KEY) {
      res.status(500).json({ error: { message: "Anthropic API key not configured", type: "server_error" } });
      return;
    }
    const { model, messages, max_tokens, temperature, stream } = req.body as {
      model?: string; messages?: Array<{ role: string; content: string }>; max_tokens?: number; temperature?: number; stream?: boolean;
    };
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: { message: "messages array is required", type: "invalid_request_error" } });
      return;
    }

    const modelId = model || "claude-sonnet-4-6";
    const validModels = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-6"];
    const anthropicModel = validModels.includes(modelId) ? modelId : "claude-sonnet-4-6";

    let systemPrompt = "";
    const anthropicMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content;
      } else if (msg.role === "user" || msg.role === "assistant") {
        anthropicMessages.push({ role: msg.role, content: msg.content });
      }
    }
    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: "user", content: "Hello" });
    }

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const response = await client.messages.create({
      model: anthropicModel,
      max_tokens: max_tokens || 4096,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: anthropicMessages,
    });

    const textContent = response.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

    res.json({
      id: completionId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: anthropicModel,
      choices: [{
        index: 0,
        message: { role: "assistant", content: textContent },
        finish_reason: response.stop_reason === "end_turn" ? "stop" : response.stop_reason === "max_tokens" ? "length" : "stop",
      }],
      usage: {
        prompt_tokens: response.usage?.input_tokens || 0,
        completion_tokens: response.usage?.output_tokens || 0,
        total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      },
    });
  } catch (err: any) {
    console.error("[openai-proxy] Error:", err.message || err);
    const status = err.status || 500;
    res.status(status).json({ error: { message: err.message || "Internal server error", type: "server_error" } });
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

app.post("/api/telegram/webhook", express.json(), async (req, res) => {
  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  if (secretHeader !== telegram.getWebhookSecret()) {
    res.sendStatus(403);
    return;
  }
  try {
    await telegram.handleWebhookUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("[telegram] Webhook handler error:", err);
    res.sendStatus(200);
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
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`Got ${signal} — closing server...`);
  if (obSyncProcess) {
    try { obSyncProcess.kill(); } catch {}
    obSyncProcess = null;
  }
  scheduledJobs.stopJobSystem();
  telegram.stop();
  const ids = [...sessions.keys()];
  if (ids.length > 0) {
    console.error(`[shutdown] Saving ${ids.length} active session(s)...`);
    const results = await Promise.allSettled(ids.map(id => saveAndCleanSession(id)));
    const saved = results.filter(r => r.status === "fulfilled").length;
    const failed = results.filter(r => r.status === "rejected").length;
    console.error(`[shutdown] Sessions saved: ${saved}, failed: ${failed}`);
  }
  server.close(() => {
    console.error("[shutdown] Server closed cleanly");
    setTimeout(() => process.exit(0), 500);
  });
  setTimeout(() => {
    console.error("[shutdown] Forced exit after timeout");
    process.exit(1);
  }, 8000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

function killPort(port: number) {
  try {
    execSync(`fuser -k -9 ${port}/tcp`, { stdio: "ignore" });
  } catch {}
  try {
    execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, { stdio: "ignore" });
  } catch {}
}

function getPortPids(port: number): number[] {
  try {
    const out = execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: "utf-8" });
    return out.trim().split(/\s+/).map(s => parseInt(s)).filter(n => !isNaN(n) && n > 0 && n !== port);
  } catch {
    return [];
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPort(port: number, maxWaitMs = 30000) {
  const start = Date.now();
  let attempt = 0;
  killPort(port);
  await new Promise(r => setTimeout(r, 1000));
  while (Date.now() - start < maxWaitMs) {
    const pids = getPortPids(port);
    if (pids.length === 0) return true;
    attempt++;
    const alivePids = pids.filter(isPidAlive);
    if (alivePids.length === 0) {
      await new Promise(r => setTimeout(r, 500));
      return true;
    }
    console.warn(`[boot] Port ${port} still held by PIDs: ${alivePids.join(", ")} — killing (attempt ${attempt})`);
    for (const pid of alivePids) {
      try { process.kill(pid, 9); } catch {}
    }
    killPort(port);
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function runStartupRecovery() {
  const startupTime = Date.now();
  console.log("[recovery] Running startup recovery checks...");

  try {
    const migPool = db.getPool();
    const portfolioRes = await migPool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_portfolio_value'`);
    if (portfolioRes.rows.length > 0 && portfolioRes.rows[0].value === 50) {
      await migPool.query(
        `UPDATE app_config SET value = $1, updated_at = $2 WHERE key = 'wealth_engines_portfolio_value'`,
        [JSON.stringify(1000), Date.now()]
      );
      console.log("[recovery] Migrated portfolio value: $50 → $1,000");
    }
    const peakRes = await migPool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_peak_portfolio'`);
    if (peakRes.rows.length > 0 && peakRes.rows[0].value === 50) {
      await migPool.query(
        `UPDATE app_config SET value = $1, updated_at = $2 WHERE key = 'wealth_engines_peak_portfolio'`,
        [JSON.stringify(1000), Date.now()]
      );
      console.log("[recovery] Migrated peak portfolio: $50 → $1,000");
    }
  } catch (migErr) {
    console.error("[recovery] Portfolio migration check failed:", migErr instanceof Error ? migErr.message : migErr);
  }

  let previousLastTick = 0;
  try {
    const pool = db.getPool();
    const lastMonitorRes = await pool.query(`SELECT value FROM app_config WHERE key = 'bankr_monitor_last_tick'`);
    if (lastMonitorRes.rows.length > 0) {
      previousLastTick = typeof lastMonitorRes.rows[0].value === "number" ? lastMonitorRes.rows[0].value : parseInt(String(lastMonitorRes.rows[0].value));
    }
  } catch {}

  if (previousLastTick > 0) {
    const downMinutes = Math.floor((startupTime - previousLastTick) / 60000);
    if (downMinutes > 10) {
      console.warn(`[recovery] System was down for ~${downMinutes} minutes (last monitor tick: ${new Date(previousLastTick).toISOString()})`);
    }
  }

  try {
    const monitorResult = await bankr.runPositionMonitor();
    const monitorPool = db.getPool();
    await monitorPool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('bankr_monitor_last_tick', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(Date.now()), Date.now()]
    );
    console.log(`[recovery] Position monitor: ${monitorResult.checked} checked, ${monitorResult.closed.length} closed`);
    if (monitorResult.closed.length > 0) {
      for (const trade of monitorResult.closed) {
        await telegram.sendTradeAlert({
          type: trade.close_reason === "kill_switch" ? "emergency" : "stopped",
          asset: trade.asset,
          direction: trade.direction,
          exitPrice: trade.exit_price.toFixed(2),
          pnl: trade.pnl,
          reason: trade.close_reason,
        });
      }
    }
  } catch (err) {
    console.error("[recovery] Position monitor failed:", err instanceof Error ? err.message : err);
  }

  try {
    const { refreshShadowTradesFromMarket } = await import("./src/oversight.js");
    const shadowResult = await refreshShadowTradesFromMarket();
    console.log(`[recovery] Shadow prices refreshed: ${shadowResult.updated} updated, ${shadowResult.closed} closed`);
  } catch (err) {
    console.error("[recovery] Shadow price refresh failed:", err instanceof Error ? err.message : err);
  }

  try {
    const jobs = scheduledJobs.getJobs();
    const missedJobs: string[] = [];
    for (const job of jobs) {
      if (!job.enabled || !job.lastRun) continue;
      const lastRunTime = new Date(job.lastRun).getTime();
      if (isNaN(lastRunTime)) continue;
      let expectedIntervalMs = 0;
      if (job.schedule.type === "interval" && job.schedule.intervalMinutes) {
        expectedIntervalMs = job.schedule.intervalMinutes * 60 * 1000;
      } else if (job.schedule.type === "daily") {
        expectedIntervalMs = 24 * 60 * 60 * 1000;
      } else if (job.schedule.type === "weekly") {
        expectedIntervalMs = 7 * 24 * 60 * 60 * 1000;
      }
      if (expectedIntervalMs > 0) {
        const elapsed = startupTime - lastRunTime;
        if (elapsed > expectedIntervalMs * 2) {
          const missedWindows = Math.floor(elapsed / expectedIntervalMs) - 1;
          missedJobs.push(`${job.name} (missed ~${missedWindows} window${missedWindows > 1 ? "s" : ""}, last ran ${Math.floor(elapsed / 60000)}m ago)`);
        }
      }
    }
    if (missedJobs.length > 0) {
      console.warn(`[recovery] Missed job windows detected:\n  - ${missedJobs.join("\n  - ")}`);
      telegram.sendMessage(`⚠️ *Missed Job Windows*\n\n${missedJobs.map(j => `• ${j}`).join("\n")}`).catch(() => {});
    } else {
      console.log("[recovery] No missed job windows detected");
    }
  } catch (err) {
    console.error("[recovery] Missed job check failed:", err instanceof Error ? err.message : err);
  }
}

async function sendStartupNotification(googleStatus: { connected: boolean; email?: string; error?: string }) {
  const jobs = scheduledJobs.getJobs();
  const enabledJobs = jobs.filter(j => j.enabled).length;
  const bnkrStatus = (await import("./src/bnkr.js")).isConfigured() ? "Live" : "Shadow";
  const googleLine = googleStatus.connected ? `✅ ${googleStatus.email}` : `❌ Disconnected`;
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  const msg = [
    `🟢 *DarkNode Online*`,
    ``,
    `⏰ ${now} ET`,
    `📋 Jobs: ${enabledJobs} active`,
    `🏦 BNKR: ${bnkrStatus}`,
    `📧 Google: ${googleLine}`,
  ].join("\n");

  await telegram.sendMessage(msg);
}

async function startServer(maxRetries = 5) {
  await db.init();
  await conversations.init();
  await gmail.init();
  await tasks.init();
  await alerts.init();
  await telegram.init();
  oversight.setTelegramNotifier(async (msg: string) => {
    await telegram.sendMessage(msg);
  });
  await scheduledJobs.init();
  try {
    const pool = (await import("./src/db.js")).getPool();
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_public', $1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(false), Date.now()]
    );
  } catch {}
  console.log("[boot] PostgreSQL ready (shared pool, 4 tables)");

  let googleStatus: { connected: boolean; email?: string; error?: string } = { connected: false };
  try {
    googleStatus = await gmail.checkConnectionStatus();
    if (googleStatus.connected) {
      console.log(`[boot] Google connected: ${googleStatus.email} (Gmail, Calendar, Drive, Sheets)`);
    } else {
      console.warn(`[boot] Google not connected: ${googleStatus.error}`);
      telegram.sendMessage(`⚠️ *Google Disconnected*\n\nGmail, Calendar, Drive, Sheets are offline.\nReconnect: /api/gmail/auth`).catch(() => {});
    }
  } catch {}

  let lastGoogleAlertSent = 0;
  setInterval(async () => {
    try {
      const token = await gmail.getAccessToken();
      if (token) {
        console.log("[google-health] Token valid — auto-refreshed successfully");
        lastGoogleAlertSent = 0;
      } else {
        console.warn("[google-health] Token refresh failed — Google auth needs reconnection at /api/gmail/auth");
        const now = Date.now();
        if (now - lastGoogleAlertSent > 12 * 60 * 60 * 1000) {
          lastGoogleAlertSent = now;
          telegram.sendMessage(`⚠️ *Google Auth Failed*\n\nToken refresh failed. Gmail jobs are silently failing.\nReconnect: /api/gmail/auth`).catch(() => {});
        }
      }
    } catch (err: any) {
      console.error("[google-health] Auth check failed:", err.message);
      const now = Date.now();
      if (now - lastGoogleAlertSent > 12 * 60 * 60 * 1000) {
        lastGoogleAlertSent = now;
        telegram.sendMessage(`⚠️ *Google Auth Error*\n\n${err.message}\nReconnect: /api/gmail/auth`).catch(() => {});
      }
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
    telegram.forwardAlertToTelegram(event).catch(err => {
      console.error("[telegram] Forward failed:", err instanceof Error ? err.message : err);
    });
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    killPort(PORT);
    await new Promise(r => setTimeout(r, attempt === 1 ? 500 : 1000));
    try {
      await new Promise<void>((resolve, reject) => {
        server = createServer(app);
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && attempt < maxRetries) {
            console.warn(`[boot] EADDRINUSE on attempt ${attempt}/${maxRetries} — killing port and retrying...`);
            server.close();
            killPort(PORT);
            reject(err);
          } else {
            console.error(`[boot] Fatal server error:`, err);
            process.exit(1);
          }
        });
        server.listen({ port: PORT, host: "0.0.0.0", exclusive: false }, async () => {
          console.log(`[ready] pi-replit listening on http://localhost:${PORT}`);
          try {
            const bootPool = db.getPool();
            await bootPool.query(
              `INSERT INTO app_config (key, value, updated_at) VALUES ('system_boot_time', $1, $2)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
              [JSON.stringify(Date.now()), Date.now()]
            );
          } catch {}
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
              return result;
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

          setInterval(async () => {
            try {
              const result = await bankr.runPositionMonitor();
              const monitorPool = db.getPool();
              await monitorPool.query(
                `INSERT INTO app_config (key, value, updated_at) VALUES ('bankr_monitor_last_tick', $1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
                [JSON.stringify(Date.now()), Date.now()]
              );
              if (result.closed.length > 0) {
                for (const trade of result.closed) {
                  await telegram.sendTradeAlert({
                    type: trade.close_reason === "kill_switch" ? "emergency" : "stopped",
                    asset: trade.asset,
                    direction: trade.direction,
                    exitPrice: trade.exit_price.toFixed(2),
                    pnl: trade.pnl,
                    reason: trade.close_reason,
                  });
                }
              }
              if (result.errors.length > 0) {
                console.warn("[bankr-monitor] Errors:", result.errors.join("; "));
              }
            } catch (err) {
              console.error("[bankr-monitor] Position monitor error:", err);
            }
          }, 5 * 60 * 1000);
          console.log("[boot] BANKR position monitor started (5-min interval)");

          runStartupRecovery().catch(err => {
            console.error("[recovery] Startup recovery failed:", err instanceof Error ? err.message : err);
          });

          sendStartupNotification(googleStatus).catch(err => {
            console.error("[boot] Startup notification failed:", err instanceof Error ? err.message : err);
          });

          resolve();
        });
      });
      return;
    } catch {
      killPort(PORT);
      const delay = Math.min(3000 * attempt, 10000);
      console.log(`[boot] Waiting ${delay}ms before retry...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.error(`[boot] Could not bind port ${PORT} after ${maxRetries} attempts — exiting`);
  process.exit(1);
}

startServer();
