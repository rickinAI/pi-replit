import { classifyEmail, shouldWriteToVault, type ClassifiedEmail, type InboxType } from "./email-classifier.js";
import { logPipelineEvent, updatePipelineEvent, type PipelineEventMetadata } from "./pipeline-store.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || "";

export function isResendConfigured(): boolean {
  return RESEND_API_KEY.length > 0;
}

export function hasWebhookSecret(): boolean {
  return RESEND_WEBHOOK_SECRET.length > 0;
}

interface ResendWebhookEvent {
  type: string;
  data: {
    email_id?: string;
    to?: string[];
    from?: string;
    subject?: string;
    created_at?: string;
  };
}

interface InboundEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  created_at: string;
}

export async function verifyWebhookSignature(
  payload: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null }
): Promise<boolean> {
  if (!hasWebhookSecret()) return false;

  const { Webhook } = await import("svix");
  try {
    const wh = new Webhook(RESEND_WEBHOOK_SECRET);
    wh.verify(payload, {
      "svix-id": headers.id || "",
      "svix-timestamp": headers.timestamp || "",
      "svix-signature": headers.signature || "",
    });
    return true;
  } catch {
    return false;
  }
}

export async function fetchInboundEmail(emailId: string): Promise<InboundEmail | null> {
  try {
    const resp = await fetch(`https://api.resend.com/emails/${emailId}`, {
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}` },
    });
    if (!resp.ok) {
      console.error(`[resend] Failed to fetch email ${emailId}: ${resp.status}`);
      return null;
    }
    return await resp.json() as InboundEmail;
  } catch (err) {
    console.error("[resend] Fetch email error:", err instanceof Error ? err.message : err);
    return null;
  }
}

function extractSenderDomain(sender: string): string {
  const match = sender.match(/@([^>]+)/);
  return match ? match[1].toLowerCase() : "unknown";
}

export async function handleInboundWebhook(
  payload: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null }
): Promise<{ status: string; classification?: ClassifiedEmail; error?: string }> {
  if (hasWebhookSecret()) {
    const valid = await verifyWebhookSignature(payload, headers);
    if (!valid) {
      console.warn("[resend] Webhook signature verification failed");
      return { status: "rejected", error: "Invalid signature" };
    }
  }

  let event: ResendWebhookEvent;
  try {
    event = JSON.parse(payload);
  } catch {
    return { status: "error", error: "Invalid JSON payload" };
  }

  if (event.type !== "email.received") {
    console.log(`[resend] Ignoring event type: ${event.type}`);
    return { status: "ignored" };
  }

  const recipient = (event.data.to?.[0] || "").toLowerCase();
  const sender = (event.data.from || "").toLowerCase();
  const subject = event.data.subject || "(no subject)";

  console.log(`[resend] Inbound email: ${sender} → ${recipient} | "${subject}"`);

  let email: InboundEmail | null = null;
  if (event.data.email_id) {
    email = await fetchInboundEmail(event.data.email_id);
  }

  const bodyText = email?.text || email?.html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "";
  const bodyPreview = bodyText.slice(0, 500);

  const classification = classifyEmail({
    to: recipient,
    from: sender,
    subject,
    bodyPreview,
  });

  console.log(`[resend] Classified: inbox=${classification.inbox} category=${classification.category} folder=${classification.vaultFolder} allowed=${classification.allowed}`);

  const isRejected = !classification.allowed;
  const writeVault = isRejected || shouldWriteToVault(classification.inbox, bodyText.length);

  const metadata: PipelineEventMetadata = {
    inbox: classification.inbox,
    category: classification.category,
    sender_domain: extractSenderDomain(sender),
    classification_confidence: "rule_match",
    vault_written: false,
    vault_path: null,
    reject_reason: classification.rejectReason || null,
    body_length: bodyText.length,
    parsed_signals: [],
  };

  let pipelineId: number;
  try {
    pipelineId = await logPipelineEvent({
      inbox: classification.inbox,
      category: classification.category,
      sender,
      subject,
      status: isRejected ? "rejected" : "processed",
      metadata,
      created_at: Date.now(),
    });
    console.log(`[resend] Pipeline event #${pipelineId} logged to DB`);
  } catch (err) {
    console.error("[resend] Pipeline DB write failed:", err instanceof Error ? err.message : err);
    pipelineId = -1;
  }

  let vaultPath: string | null = null;
  if (writeVault) {
    vaultPath = await saveToVault(classification, sender, subject, email, bodyText);
    if (pipelineId > 0) {
      try {
        if (vaultPath) {
          await updatePipelineEvent(pipelineId, {
            metadata: { vault_written: true, vault_path: vaultPath } as any,
          });
        } else {
          await updatePipelineEvent(pipelineId, {
            status: "error",
            metadata: { vault_written: false, reject_reason: "vault_write_failed" } as any,
          });
        }
      } catch {}
    }
  } else {
    console.log(`[resend] Vault write skipped for ${classification.inbox}@ (bodyLength=${bodyText.length})`);
  }

  await sendTelegramNotification(classification, sender, subject, isRejected, vaultPath);

  return isRejected
    ? { status: "rejected", classification, error: classification.rejectReason }
    : { status: "processed", classification };
}

async function saveToVault(
  classification: ClassifiedEmail,
  from: string,
  subject: string,
  email: InboundEmail | null,
  bodyText: string
): Promise<string | null> {
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const cleanSubject = subject
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const filename = `${dateStr} - ${cleanSubject || "Email"}.md`;
    const fullPath = `${classification.vaultFolder}/${filename}`;

    const frontmatter = [
      "---",
      `source: email`,
      `inbox: ${classification.inbox}`,
      `from: "${from}"`,
      `received: ${new Date().toISOString()}`,
      `category: ${classification.category}`,
      `tags: [${classification.tags.join(", ")}]`,
      "---",
    ].join("\n");

    const body = bodyText || "(empty body)";

    const content = [
      frontmatter,
      "",
      `# ${subject}`,
      "",
      `**From:** ${from}`,
      `**Received:** ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
      `**Inbox:** ${classification.inbox}@agents.rickin.live`,
      `**Category:** ${classification.category}`,
      "",
      "---",
      "",
      body.slice(0, 10000),
      "",
      "---",
      `*Received via ${classification.inbox}@agents.rickin.live*`,
    ].join("\n");

    const vaultLocal = await import("./vault-local.js");
    let savedPath = fullPath;
    try {
      await vaultLocal.createNote(fullPath, content);
    } catch {
      savedPath = `Library/Inbox/${filename}`;
      await vaultLocal.createNote(savedPath, content);
      console.warn(`[resend] Failed to write to ${fullPath}, fell back to Library/Inbox/`);
    }

    const logLine = `- ${new Date().toISOString().slice(0, 16).replace("T", " ")} | email | ${subject.slice(0, 60)} | ${from} → ${savedPath}\n`;
    const logPath = "Library/Vault-Inbox-Log.md";
    try {
      await vaultLocal.appendToNote(logPath, logLine);
    } catch {
      try {
        await vaultLocal.createNote(logPath, `# Vault Inbox Log\n\n${logLine}`);
      } catch {}
    }

    try {
      const { getPool } = await import("./db.js");
      const pool = getPool();
      await pool.query(
        `INSERT INTO agent_activity (agent, task, saved_to, created_at) VALUES ($1, $2, $3, $4)`,
        ["resend-inbox", `Email: ${subject}`.slice(0, 200), savedPath, Date.now()]
      );
    } catch {}

    console.log(`[resend] Saved to vault: ${savedPath}`);
    return savedPath;
  } catch (err) {
    console.error("[resend] Vault save failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function sendTelegramNotification(
  classification: ClassifiedEmail,
  from: string,
  subject: string,
  isRejected: boolean,
  vaultPath: string | null
): Promise<void> {
  try {
    const { sendAlertsBotMessage } = await import("./telegram.js");
    const fmt = await import("./telegram-format.js");

    const inboxEmoji: Record<InboxType, string> = {
      node: "🔴",
      intel: "🔍",
      engine: "⚙️",
      vault: "📦",
      access: "🌐",
    };

    const emoji = inboxEmoji[classification.inbox] || "📧";
    const badge = isRejected ? fmt.CATEGORY_BADGES.OVERSIGHT : fmt.CATEGORY_BADGES.DISCOVERY;
    const headerText = isRejected
      ? `${emoji} Email Rejected — ${classification.inbox}@`
      : `${emoji} Email Filed — ${classification.inbox}@`;

    const lines = [
      fmt.buildCategoryHeader(badge, headerText),
      "",
      `<b>From:</b> ${fmt.escapeHtml(from)}`,
      `<b>Subject:</b> ${fmt.escapeHtml(subject.slice(0, 100))}`,
    ];

    if (isRejected) {
      lines.push(`<b>Reason:</b> ${fmt.escapeHtml(classification.rejectReason || "Unknown")}`,);
      lines.push("", `⚠️ Saved to <code>System/Email-Unrouted/</code> for review`);
    } else {
      lines.push(`<b>Category:</b> ${fmt.escapeHtml(classification.category)}`);
      if (vaultPath) {
        lines.push(`<b>Filed to:</b> <code>${fmt.escapeHtml(vaultPath)}</code>`);
      } else {
        lines.push(`<i>Vault write skipped (DB-only)</i>`);
      }
    }

    await sendAlertsBotMessage(lines.join("\n"), "HTML");
  } catch (err) {
    console.error("[resend] Telegram notification failed:", err instanceof Error ? err.message : err);
  }
}
