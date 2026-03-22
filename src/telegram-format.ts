export const CATEGORY_BADGES: Record<string, string> = {
  WHALE_INTEL: "🐋 WHALE INTEL",
  COPY_TRADE: "⚡ COPY TRADE",
  SHADOW_BOOK: "👻 SHADOW BOOK",
  SCOUT: "🔍 SCOUT",
  OVERSIGHT: "🛡️ OVERSIGHT",
  DISCOVERY: "🌱 DISCOVERY",
  DAILY_BRIEF: "📊 DAILY BRIEF",
  AUTO_REDEEM: "🎉 AUTO-REDEEM",
  DEAD_MAN: "⚠️ DEAD MAN",
  CIRCUIT_BREAK: "🔴 CIRCUIT BREAK",
};

export const NICHE_EMOJI: Record<string, string> = {
  weather: "🌤️",
  politics: "🏛️",
  sports: "⚽",
  crypto: "₿",
  esports: "🎮",
  general: "🐋",
  unknown: "🔍",
};

export const MARKET_CATEGORY_BADGE: Record<string, string> = {
  weather: "🌤️ Weather",
  politics: "🏛️ Politics",
  sports: "⚽ Sports",
  crypto: "₿ Crypto",
  esports: "🎮 Esports",
  general: "📋 General",
};

export const CONFIDENCE_BARS: Record<string, string> = {
  SPECULATIVE: "🟨🟨⬜⬜⬜⬜⬜⬜⬜⬜  2/10",
  LOW: "🟧🟧🟧⬜⬜⬜⬜⬜⬜⬜  3/10",
  MEDIUM: "🟩🟩🟩🟩🟩⬜⬜⬜⬜⬜  5/10",
  HIGH: "🟩🟩🟩🟩🟩🟩🟩🟩⬜⬜  8/10",
};

export const SEPARATOR = "───────────────";

export const SECTION_EMOJIS: Record<string, string> = {
  urgent: "🚨",
  calendar: "📅",
  calendar_tomorrow: "📅",
  tasks: "✅",
  email: "📬",
  markets: "📈",
  headlines: "📰",
  news: "📰",
  weather: "🌤️",
  portfolio: "📊",
  theses: "🎯",
  system: "⚡",
  shadow: "👻",
};

export const FAMILY_EMOJIS: Record<string, string> = {
  rickin: "👨‍💻",
  pooja: "🤰",
  reya: "👧",
};

export const PRIORITY_CIRCLES: Record<string, string> = {
  urgent: "🔴",
  notable: "🟡",
  routine: "🟢",
};

export const EMAIL_CATEGORY_ICONS: Record<string, string> = {
  Travel: "✈️",
  Financial: "💰",
  Shopping: "📦",
  Documents: "📄",
  Calendar: "📅",
  Updates: "💼",
  Email: "📧",
};

const HIGH_ONELINERS = [
  "Whale loading up — high conviction play",
  "Big money moving in with confidence",
  "Heavy hitter doubling down on this market",
  "Smart money says this is the one",
];

const MEDIUM_ONELINERS = [
  "Cautious entry — watching for confirmation",
  "Measured bet — not going all-in yet",
  "Testing the waters with moderate size",
  "Hedge-style entry — keeping options open",
];

const LOW_ONELINERS = [
  "Observational position — small sizing noted",
  "Watching from the edges — low conviction",
  "Speculative nibble — could go either way",
  "Barely a whisper — keeping it on radar",
];

export function buildCategoryHeader(badge: string, label: string): string {
  return `${badge} · ${label}`;
}

export function buildConfidenceBar(confidence: string): string {
  const upper = confidence.toUpperCase();
  return CONFIDENCE_BARS[upper] || CONFIDENCE_BARS["MEDIUM"];
}

export function buildProgressBar(current: number, target: number, width: number = 10): string {
  const ratio = target > 0 ? Math.min(current / target, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function buildMoodIndicator(weeklyPnlPct: number): string {
  if (weeklyPnlPct > 5) return "😎 Crushing it";
  if (weeklyPnlPct >= 1) return "🟢 Solid";
  if (weeklyPnlPct >= -1) return "🟡 Flat";
  if (weeklyPnlPct >= -5) return "🔴 Rough patch";
  return "💀 Pain mode";
}

export function buildStreakText(currentStreak: number, streakType: "W" | "L"): string {
  if (currentStreak <= 0) return "";
  if (streakType === "W") return `🔥 ${currentStreak} win streak`;
  return `❄️ ${currentStreak} loss streak`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function truncateToTelegramLimit(text: string, limit: number = 4096): string {
  if (text.length <= limit) return text;
  const suffix = "\n[...truncated]";
  return text.slice(0, limit - suffix.length) + suffix;
}

export function truncateAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr || "unknown";
  return `${addr.slice(0, 5)}...${addr.slice(-3)}`;
}

export function getOneLiner(confidence: string): string {
  const upper = confidence.toUpperCase();
  let pool: string[];
  if (upper === "HIGH") pool = HIGH_ONELINERS;
  else if (upper === "MEDIUM") pool = MEDIUM_ONELINERS;
  else pool = LOW_ONELINERS;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function getNicheEmoji(niche: string): string {
  return NICHE_EMOJI[niche?.toLowerCase()] || NICHE_EMOJI["unknown"];
}

export function getMarketBadge(niche: string): string {
  return MARKET_CATEGORY_BADGE[niche?.toLowerCase()] || MARKET_CATEGORY_BADGE["general"];
}

export function formatETTime(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " ET";
}

export function formatPnl(pnl: number): string {
  return pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
}

export function formatPct(pct: number): string {
  return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
}

export function resolveFamilyEmoji(calendarName: string, eventTitle?: string): string {
  const name = calendarName.toLowerCase();
  const title = (eventTitle || "").toLowerCase();

  if (name.includes("reya") || title.includes("reya")) return FAMILY_EMOJIS.reya;
  if (name.includes("pooja") || title.includes("pooja")) return FAMILY_EMOJIS.pooja;
  if (name === "rickin" || name === "primary" || name.includes("rickin")) return FAMILY_EMOJIS.rickin;

  if (title.includes("rickin")) return FAMILY_EMOJIS.rickin;

  return "📅";
}

export function truncateForTelegram(text: string, limit: number = 4000): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n\n<i>…truncated</i>";
}

export function sanitizeForTelegramHtml(text: string): string {
  return text
    .replace(/&(?!amp;|lt;|gt;)/g, "&amp;")
    .replace(/<(?!\/?(?:b|i|u|s|a|code|pre)[\s>])/g, "&lt;")
    .replace(/(?<!<\/?\w+\s*[^>]*)>/g, (match, offset, str) => {
      const before = str.slice(Math.max(0, offset - 50), offset);
      if (/<\/?(?:b|i|u|s|a|code|pre)[^>]*$/.test(before)) return match;
      return "&gt;";
    });
}

export function escapeAndPreserveHtmlTags(text: string): string {
  const allowedTags = /<\/?(b|i|u|s|a|code|pre)(\s[^>]*)?>/g;
  const preserved: Array<{ placeholder: string; tag: string }> = [];
  let idx = 0;
  const withPlaceholders = text.replace(allowedTags, (match) => {
    const placeholder = `\x00TAG${idx++}\x00`;
    preserved.push({ placeholder, tag: match });
    return placeholder;
  });

  let escaped = escapeHtml(withPlaceholders);
  for (const { placeholder, tag } of preserved) {
    escaped = escaped.replace(placeholder, tag);
  }
  return escaped;
}

export function formatTelegramBriefHeader(briefType: string, mode: string): string {
  const label = briefType.charAt(0).toUpperCase() + briefType.slice(1);
  return `${mode} 📋 <b>${escapeHtml(label)} Brief</b>`;
}

export function formatTelegramBrief(briefType: string, mode: string, body: string): string {
  const label = briefType.charAt(0).toUpperCase() + briefType.slice(1);
  const header = `${mode} 📋 <b>${escapeHtml(label)} Brief</b>`;
  const safeBody = escapeAndPreserveHtmlTags(body);
  const full = `${header}\n\n${safeBody}`;
  return truncateForTelegram(full, 4000);
}

export function formatTelegramSectionHeader(sectionName: string): string {
  const emoji = SECTION_EMOJIS[sectionName] || "📌";
  const label = sectionName === "calendar_tomorrow" ? "Tomorrow" : sectionName.charAt(0).toUpperCase() + sectionName.slice(1);
  return `${emoji} <b>${escapeHtml(label)}</b>`;
}

export function formatTelegramAlert(mode: string, icon: string, title: string, priority: string, content: string): string {
  const priorityCircle = priority === "Action needed" ? PRIORITY_CIRCLES.urgent
    : priority === "Travel" ? "✈️"
    : priority === "Financial" ? "💰"
    : PRIORITY_CIRCLES.notable;
  const escapedTitle = escapeHtml(title);
  const escapedContent = escapeHtml(content);
  return `${mode} ${icon} <b>${escapedTitle}</b>\n${priorityCircle} ${escapeHtml(priority)}\n━━━━━━━━━━━━\n${escapedContent}`;
}

export function formatEmailBatchGrouped(emails: Array<{ sender: string; subject: string; icon: string; category: string }>): string {
  const groups: Record<string, Array<{ sender: string; subject: string; icon: string }>> = {};
  for (const e of emails) {
    if (!groups[e.category]) groups[e.category] = [];
    groups[e.category].push(e);
  }

  const lines: string[] = [];
  for (const [category, items] of Object.entries(groups)) {
    const catIcon = EMAIL_CATEGORY_ICONS[category] || "📧";
    lines.push(`${catIcon} <b>${escapeHtml(category)}</b>`);
    for (const item of items) {
      lines.push(`  • ${escapeHtml(item.subject)} — <i>${escapeHtml(item.sender)}</i>`);
    }
  }
  return lines.join("\n");
}

export function formatDarkNodeSection(title: string, emoji: string): string {
  return `━━━━━━━━━━━━\n${emoji} <b>${escapeHtml(title)}</b>`;
}

export function buildTelegramSynthesisPrompt(type: string, rawSections: string): string {
  return `You are Rickin's personal assistant delivering his ${type} briefing via Telegram. Synthesize the following raw data into a concise, engaging briefing optimized for Telegram's HTML format.

Format rules:
- Use these section emojis as headers: 🚨 URGENT, 📅 TODAY/TOMORROW, ✅ TASKS, 📬 EMAIL, 📈 MARKETS, 📰 HEADLINES, 🌤️ WEATHER
- Use priority circles for items: 🔴 for urgent/action-needed, 🟡 for notable, 🟢 for routine
- Use family emojis when referencing people: 👨‍💻 Rickin, 🤰 Pooja, 👧 Reya
- Use email category emojis: ✈️ Travel, 💰 Financial, 📦 Shopping, 📄 Documents, 📅 Calendar, 💼 Updates
- Write punchy one-liner bullet points — no filler, no fluff
- Group items by category, don't just flat-list everything
- Use "━━━━━━━━━━━━" as visual separators between major sections
- If a section has no data or says "not connected", skip it entirely
- For markets, highlight notable moves with direction arrows (▲/▼); don't just list prices
- For calendar, emphasize timing and what's next, include the family member emoji if the event is tied to a specific person
- For email, mention sender and subject briefly with category emoji
- Keep each bullet to ONE line max
- Do NOT use markdown. Use plain text with emojis only — no **, ##, or other markdown syntax
- Output clean text with emojis, bullet points (•), and line breaks only

RAW DATA:
${rawSections}`;
}
