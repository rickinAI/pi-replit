const STRIP_TAGS = new Set([
  "script", "style", "noscript", "iframe", "object", "embed",
  "svg", "canvas", "template", "form", "input", "button", "select",
  "textarea", "fieldset", "nav", "footer", "header", "aside",
]);

const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "blockquote", "pre", "table", "tr", "td", "th",
  "article", "section", "main", "figure", "figcaption",
]);

const AD_PATTERNS = [
  /class="[^"]*\b(ad[s_-]|banner|sponsor|promo|sidebar|popup|modal|cookie|gdpr|newsletter|signup|subscribe)\b[^"]*"/gi,
  /id="[^"]*\b(ad[s_-]|banner|sponsor|sidebar|popup|modal|cookie|gdpr)\b[^"]*"/gi,
  /aria-label="[^"]*\b(advertisement|sponsored|cookie|banner)\b[^"]*"/gi,
];

export function cleanHtmlToMarkdown(html: string): string {
  if (!html || typeof html !== "string") return "";

  let cleaned = html;

  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");

  for (const tag of STRIP_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    cleaned = cleaned.replace(re, "");
    const selfClose = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    cleaned = cleaned.replace(selfClose, "");
  }

  for (const pattern of AD_PATTERNS) {
    cleaned = cleaned.replace(new RegExp(`<[a-z]+\\s+[^>]*${pattern.source}[^>]*>[\\s\\S]*?<\\/[a-z]+>`, "gi"), "");
  }

  cleaned = cleaned.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*\balt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
  cleaned = cleaned.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*\bsrc="([^"]+)"[^>]*\/?>/gi, "![$1]($2)");
  cleaned = cleaned.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*\/?>/gi, "![]($1)");

  cleaned = cleaned.replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  cleaned = cleaned.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => {
    return "\n" + "#".repeat(parseInt(level)) + " " + stripTags(text).trim() + "\n";
  });

  cleaned = cleaned.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  cleaned = cleaned.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  cleaned = cleaned.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  cleaned = cleaned.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");

  cleaned = cleaned.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "- " + "$1".trim());
  cleaned = cleaned.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, text) => {
    return stripTags(text).split("\n").map((l: string) => "> " + l).join("\n");
  });

  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<hr\s*\/?>/gi, "\n---\n");

  for (const tag of BLOCK_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "\n");
  }

  cleaned = cleaned.replace(/<[^>]+>/g, "");

  cleaned = cleaned.replace(/&amp;/g, "&");
  cleaned = cleaned.replace(/&lt;/g, "<");
  cleaned = cleaned.replace(/&gt;/g, ">");
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&#039;/g, "'");
  cleaned = cleaned.replace(/&nbsp;/g, " ");
  cleaned = cleaned.replace(/&#\d+;/g, "");
  cleaned = cleaned.replace(/&\w+;/g, "");

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.replace(/[ \t]+$/gm, "");
  cleaned = cleaned.replace(/^[ \t]+$/gm, "");
  cleaned = cleaned.trim();

  return cleaned;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

export function looksLikeHtml(content: string): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML")) return true;
  const tagCount = (trimmed.match(/<[a-zA-Z][^>]*>/g) || []).length;
  return tagCount > 5 && tagCount / trimmed.length > 0.001;
}
