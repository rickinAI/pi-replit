import { classifyEmail, type ClassifiedEmail, type InboxType } from "./email-classifier.js";

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

  const bodyPreview = (email?.text || "").slice(0, 500);

  const classification = classifyEmail({
    to: recipient,
    from: sender,
    subject,
    bodyPreview,
  });

  console.log(`[resend] Classified: inbox=${classification.inbox} category=${classification.category} folder=${classification.vaultFolder} allowed=${classification.allowed}`);

  if (!classification.allowed) {
    console.warn(`[resend] Rejected: ${classification.rejectReason}`);
    await saveToVault(classification, sender, subject, email);
    await sendTelegramNotification(classification, sender, subject, true);
    return { status: "rejected", classification, error: classification.rejectReason };
  }

  await saveToVault(classification, sender, subject, email);
  await sendTelegramNotification(classification, sender, subject, false);

  return { status: "processed", classification };
}

async function saveToVault(
  classification: ClassifiedEmail,
  from: string,
  subject: string,
  email: InboundEmail | null
): Promise<void> {
  try {
    const { getPool } = await import("./db.js");

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

    const body = email?.text || email?.html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "(empty body)";

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
    try {
      await vaultLocal.createNote(fullPath, content);
    } catch {
      await vaultLocal.createNote(`Library/Inbox/${filename}`, content);
      console.warn(`[resend] Failed to write to ${fullPath}, fell back to Library/Inbox/`);
    }

    const logLine = `- ${new Date().toISOString().slice(0, 16).replace("T", " ")} | email | ${subject.slice(0, 60)} | ${from} → ${fullPath}\n`;
    const logPath = "Library/Vault-Inbox-Log.md";
    try {
      await vaultLocal.appendToNote(logPath, logLine);
    } catch {
      try {
        await vaultLocal.createNote(logPath, `# Vault Inbox Log\n\n${logLine}`);
      } catch {}
    }

    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO agent_activity (agent, task, saved_to, created_at) VALUES ($1, $2, $3, $4)`,
        ["resend-inbox", `Email: ${subject}`.slice(0, 200), fullPath, Date.now()]
      );
    } catch {}

    console.log(`[resend] Saved to vault: ${fullPath}`);
  } catch (err) {
    console.error("[resend] Vault save failed:", err instanceof Error ? err.message : err);
  }
}

async function sendTelegramNotification(
  classification: ClassifiedEmail,
  from: string,
  subject: string,
  isRejected: boolean
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
      lines.push(`<b>Filed to:</b> <code>${fmt.escapeHtml(classification.vaultFolder)}/</code>`);
    }

    await sendAlertsBotMessage(lines.join("\n"), "HTML");
  } catch (err) {
    console.error("[resend] Telegram notification failed:", err instanceof Error ? err.message : err);
  }
}
