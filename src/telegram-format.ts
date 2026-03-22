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

export const PRIORITY_CIRCLES: Record<string, string> = {
  urgent: "🔴",
  notable: "🟡",
  routine: "🟢",
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
