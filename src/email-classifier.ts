export type InboxType = "node" | "intel" | "engine" | "vault" | "access";
export type EmailCategory = string;

export interface ClassifiedEmail {
  inbox: InboxType;
  category: EmailCategory;
  vaultFolder: string;
  tags: string[];
  allowed: boolean;
  rejectReason?: string;
}

const NODE_ALLOWED_SENDERS = [
  "rickin@rickin.live",
  "rickin.patel@gmail.com",
];

const INTEL_ALLOWED_SENDERS = [
  "rickin@rickin.live",
  "rickin.patel@gmail.com",
  "alerts@bankr.bot",
  "noreply@polymarket.com",
  "newsletter@bankless.com",
  "digest@theblock.co",
  "alerts@messari.io",
  "noreply@metaculus.com",
  "alerts@kalshi.com",
  "noreply@noaa.gov",
];

const ENGINE_ALLOWED_SENDERS = [
  "rickin@rickin.live",
  "rickin.patel@gmail.com",
  "alerts@bankr.bot",
  "noreply@bnkr.bot",
  "confirmations@bnkr.bot",
];

const VAULT_ALLOWED_SENDERS = [
  "rickin@rickin.live",
  "rickin.patel@gmail.com",
];

interface SenderRule {
  domain: string;
  category: EmailCategory;
  folder: string;
}

const INTEL_SENDER_RULES: SenderRule[] = [
  { domain: "polymarket.com", category: "intel/polymarket", folder: "SCOUT/Email-Intel/Polymarket" },
  { domain: "bankless.com", category: "intel/crypto", folder: "SCOUT/Email-Intel/Crypto" },
  { domain: "theblock.co", category: "intel/crypto", folder: "SCOUT/Email-Intel/Crypto" },
  { domain: "messari.io", category: "intel/crypto", folder: "SCOUT/Email-Intel/Crypto" },
  { domain: "metaculus.com", category: "intel/prediction-markets", folder: "SCOUT/Email-Intel/Prediction-Markets" },
  { domain: "kalshi.com", category: "intel/prediction-markets", folder: "SCOUT/Email-Intel/Prediction-Markets" },
  { domain: "noaa.gov", category: "intel/weather", folder: "SCOUT/Email-Intel/Weather" },
];

const ENGINE_SENDER_RULES: SenderRule[] = [
  { domain: "bankr.bot", category: "engine/confirmation", folder: "Scheduled Reports/Wealth Engines/BANKR" },
  { domain: "bnkr.bot", category: "engine/confirmation", folder: "Scheduled Reports/Wealth Engines/BANKR" },
];

const SUBJECT_KEYWORDS: { pattern: RegExp; category: EmailCategory; folder: string }[] = [
  { pattern: /trade|execution|order|filled|position/i, category: "engine/trade", folder: "Scheduled Reports/Wealth Engines/BANKR" },
  { pattern: /risk|drawdown|circuit.?break|margin/i, category: "engine/risk", folder: "Scheduled Reports/Wealth Engines/BANKR" },
  { pattern: /forecast|prediction|odds|probability|market/i, category: "intel/macro", folder: "SCOUT/Email-Intel/Macro" },
  { pattern: /whale|large.?trade|anomal/i, category: "intel/whale", folder: "SCOUT/Email-Intel/Whales" },
  { pattern: /weather|hurricane|storm|temperature|noaa/i, category: "intel/weather", folder: "SCOUT/Email-Intel/Weather" },
  { pattern: /crypto|bitcoin|ethereum|defi|token/i, category: "intel/crypto", folder: "SCOUT/Email-Intel/Crypto" },
  { pattern: /verify|confirm|signup|welcome|activate/i, category: "access/signup", folder: "System/Access-Inbox" },
];

const VAULT_CONTENT_RULES: { pattern: RegExp; category: string; folder: string }[] = [
  { pattern: /moody|competitor|banking|fintech/i, category: "vault/work", folder: "Projects/Moody's/Competitive Intelligence" },
  { pattern: /ai|agent|llm|machine.?learning|neural/i, category: "vault/research", folder: "Library/AI Tools" },
  { pattern: /crypto|bitcoin|ethereum|defi/i, category: "vault/crypto", folder: "Finances" },
  { pattern: /real.?estate|housing|mortgage/i, category: "vault/real-estate", folder: "Real Estate" },
  { pattern: /health|wellness|consciousness|meditation/i, category: "vault/health", folder: "Health" },
  { pattern: /career|professional|resume|interview/i, category: "vault/career", folder: "Career" },
  { pattern: /baby|child|parent|family/i, category: "vault/family", folder: "Family" },
];

function extractDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

function extractInbox(recipient: string): InboxType | null {
  const local = recipient.split("@")[0]?.toLowerCase();
  if (local === "node") return "node";
  if (local === "intel") return "intel";
  if (local === "engine") return "engine";
  if (local === "vault") return "vault";
  if (local === "access") return "access";
  return null;
}

export function classifyEmail(params: {
  to: string;
  from: string;
  subject: string;
  bodyPreview?: string;
}): ClassifiedEmail {
  const inbox = extractInbox(params.to);
  if (!inbox) {
    return {
      inbox: "access",
      category: "unrouted",
      vaultFolder: "System/Email-Unrouted",
      tags: ["source/email", "unrouted"],
      allowed: true,
    };
  }

  const senderEmail = params.from.toLowerCase().replace(/.*</, "").replace(/>.*/, "").trim();
  const senderDomain = extractDomain(senderEmail);

  if (inbox === "node") {
    if (!NODE_ALLOWED_SENDERS.includes(senderEmail)) {
      return {
        inbox: "node",
        category: "node/rejected",
        vaultFolder: "System/Email-Unrouted",
        tags: ["source/email", "node/rejected"],
        allowed: false,
        rejectReason: `Unauthorized sender: ${senderEmail}`,
      };
    }
    return {
      inbox: "node",
      category: "node/command",
      vaultFolder: "Ops/Orchestration",
      tags: ["source/email", "node/command"],
      allowed: true,
    };
  }

  if (inbox === "intel") {
    if (!INTEL_ALLOWED_SENDERS.includes(senderEmail) && !INTEL_SENDER_RULES.some(r => senderDomain.endsWith(r.domain))) {
      return {
        inbox: "intel",
        category: "intel/unknown-sender",
        vaultFolder: "System/Email-Unrouted",
        tags: ["source/email", "intel/unknown-sender"],
        allowed: false,
        rejectReason: `Unknown intel sender: ${senderEmail}`,
      };
    }

    for (const rule of INTEL_SENDER_RULES) {
      if (senderDomain.endsWith(rule.domain)) {
        return { inbox: "intel", category: rule.category, vaultFolder: rule.folder, tags: ["source/email", rule.category], allowed: true };
      }
    }

    for (const kw of SUBJECT_KEYWORDS) {
      if (kw.pattern.test(params.subject)) {
        return { inbox: "intel", category: kw.category, vaultFolder: kw.folder, tags: ["source/email", kw.category], allowed: true };
      }
    }

    return { inbox: "intel", category: "intel/general", vaultFolder: "SCOUT/Email-Intel", tags: ["source/email", "intel/general"], allowed: true };
  }

  if (inbox === "engine") {
    if (!ENGINE_ALLOWED_SENDERS.includes(senderEmail) && !ENGINE_SENDER_RULES.some(r => senderDomain.endsWith(r.domain))) {
      return {
        inbox: "engine",
        category: "engine/unknown-sender",
        vaultFolder: "System/Email-Unrouted",
        tags: ["source/email", "engine/unknown-sender"],
        allowed: false,
        rejectReason: `Unknown engine sender: ${senderEmail}`,
      };
    }

    for (const rule of ENGINE_SENDER_RULES) {
      if (senderDomain.endsWith(rule.domain)) {
        return { inbox: "engine", category: rule.category, vaultFolder: rule.folder, tags: ["source/email", rule.category], allowed: true };
      }
    }

    for (const kw of SUBJECT_KEYWORDS) {
      if (kw.pattern.test(params.subject) && kw.category.startsWith("engine/")) {
        return { inbox: "engine", category: kw.category, vaultFolder: kw.folder, tags: ["source/email", kw.category], allowed: true };
      }
    }

    return { inbox: "engine", category: "engine/general", vaultFolder: "Scheduled Reports/Wealth Engines/BANKR", tags: ["source/email", "engine/general"], allowed: true };
  }

  if (inbox === "vault") {
    if (!VAULT_ALLOWED_SENDERS.includes(senderEmail)) {
      return {
        inbox: "vault",
        category: "vault/rejected",
        vaultFolder: "System/Email-Unrouted",
        tags: ["source/email", "vault/rejected"],
        allowed: false,
        rejectReason: `Unauthorized vault sender: ${senderEmail}`,
      };
    }

    const combined = `${params.subject} ${params.bodyPreview || ""}`;
    for (const rule of VAULT_CONTENT_RULES) {
      if (rule.pattern.test(combined)) {
        return { inbox: "vault", category: rule.category, vaultFolder: rule.folder, tags: ["source/email", rule.category], allowed: true };
      }
    }

    return {
      inbox: "vault",
      category: "vault/uncategorized",
      vaultFolder: "Library/Inbox",
      tags: ["source/email", "vault/uncategorized"],
      allowed: true,
    };
  }

  if (inbox === "access") {
    for (const kw of SUBJECT_KEYWORDS) {
      if (kw.pattern.test(params.subject) && kw.category.startsWith("access/")) {
        return { inbox: "access", category: kw.category, vaultFolder: kw.folder, tags: ["source/email", kw.category], allowed: true };
      }
    }

    return { inbox: "access", category: "access/general", vaultFolder: "System/Access-Inbox", tags: ["source/email", "access/general"], allowed: true };
  }

  return {
    inbox: inbox as InboxType,
    category: "unrouted",
    vaultFolder: "System/Email-Unrouted",
    tags: ["source/email", "unrouted"],
    allowed: true,
  };
}

export function shouldWriteToVault(inbox: InboxType, bodyLength: number): boolean {
  switch (inbox) {
    case "intel":
      return true;
    case "vault":
      return true;
    case "node":
      return true;
    case "engine":
      return bodyLength > 500;
    case "access":
      return false;
    default:
      return false;
  }
}
