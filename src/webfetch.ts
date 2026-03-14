const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&ndash;": "–",
  "&mdash;": "—", "&lsquo;": "'", "&rsquo;": "'", "&ldquo;": "\u201C",
  "&rdquo;": "\u201D", "&bull;": "•", "&hellip;": "…", "&copy;": "©",
  "&reg;": "®", "&trade;": "™", "&euro;": "€", "&pound;": "£",
  "&yen;": "¥", "&cent;": "¢", "&deg;": "°", "&times;": "×",
  "&divide;": "÷", "&rarr;": "→", "&larr;": "←", "&uarr;": "↑",
  "&darr;": "↓", "&para;": "¶", "&sect;": "§", "&frac12;": "½",
  "&frac14;": "¼", "&frac34;": "¾",
};

function decodeEntities(text: string): string {
  let result = text;
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    result = result.replaceAll(entity, char);
  }
  result = result.replace(/&#(\d+);/g, (_, code) => {
    const n = parseInt(code, 10);
    return n > 0 && n < 0x10FFFF ? String.fromCodePoint(n) : "";
  });
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const n = parseInt(hex, 16);
    return n > 0 && n < 0x10FFFF ? String.fromCodePoint(n) : "";
  });
  return result;
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "").trim()) : "";
}

function extractMetaDescription(html: string): string {
  const m = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
    || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  return m ? decodeEntities(m[1].trim()) : "";
}

function htmlToText(html: string): string {
  let text = html;

  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "\n");

  text = text.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag, content) => {
    const level = parseInt(tag[1]);
    const prefix = "#".repeat(level);
    const clean = content.replace(/<[^>]+>/g, "").trim();
    return `\n\n${prefix} ${clean}\n\n`;
  });

  text = text.replace(/<(p|div|section|article|main|blockquote)[^>]*>/gi, "\n\n");
  text = text.replace(/<\/(p|div|section|article|main|blockquote)>/gi, "\n");

  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  text = text.replace(/<li[^>]*>/gi, "\n• ");
  text = text.replace(/<\/li>/gi, "");
  text = text.replace(/<\/?[ou]l[^>]*>/gi, "\n");

  text = text.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, content) => {
    const label = content.replace(/<[^>]+>/g, "").trim();
    if (!label) return "";
    if (href.startsWith("#") || href.startsWith("javascript:")) return label;
    return `${label} (${href})`;
  });

  text = text.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, "[image: $1]");

  text = text.replace(/<(td|th)[^>]*>/gi, " | ");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/?table[^>]*>/gi, "\n");

  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content) => {
    const code = content.replace(/<[^>]+>/g, "");
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });

  text = text.replace(/<[^>]+>/g, "");

  text = decodeEntities(text);

  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

export interface FetchResult {
  url: string;
  title: string;
  description: string;
  content: string;
  statusCode: number;
  contentType: string;
  byteLength: number;
  truncated: boolean;
}

const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
  /^\[fc/i,
  /^\[fd/i,
  /^\[fe80:/i,
  /metadata\.google\.internal/i,
];

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOSTS.some(re => re.test(hostname));
}

async function readBodyCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    chunks.push(decoder.decode(value, { stream: true }));
    if (totalBytes >= cap) {
      reader.cancel();
      break;
    }
  }

  return chunks.join("");
}

export async function fetchPage(url: string, options?: {
  maxLength?: number;
  timeoutMs?: number;
  includeHeaders?: Record<string, string>;
}): Promise<FetchResult> {
  const maxLen = Math.min(Math.max(options?.maxLength ?? 80_000, 1_000), 200_000);
  const timeoutMs = options?.timeoutMs ?? 15_000;

  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Blocked: only http/https URLs are allowed (got ${parsed.protocol})`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`Blocked: cannot fetch private/internal addresses`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      "Accept-Language": "en-US,en;q=0.9",
      ...(options?.includeHeaders || {}),
    };

    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });

    const finalHost = new URL(res.url).hostname;
    if (isBlockedHost(finalHost)) {
      throw new Error(`Blocked: redirect to private/internal address`);
    }

    const contentType = res.headers.get("content-type") || "";
    const rawBody = await readBodyCapped(res, MAX_BODY_BYTES);

    if (contentType.includes("application/json")) {
      let content = rawBody;
      let truncated = false;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen);
        truncated = true;
      }
      return {
        url: res.url || url,
        title: "",
        description: "",
        content,
        statusCode: res.status,
        contentType,
        byteLength: rawBody.length,
        truncated,
      };
    }

    if (contentType.includes("text/plain")) {
      let content = rawBody;
      let truncated = false;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen);
        truncated = true;
      }
      return {
        url: res.url || url,
        title: "",
        description: "",
        content,
        statusCode: res.status,
        contentType,
        byteLength: rawBody.length,
        truncated,
      };
    }

    const title = extractTitle(rawBody);
    const description = extractMetaDescription(rawBody);
    let content = htmlToText(rawBody);
    let truncated = false;

    if (content.length > maxLen) {
      content = content.slice(0, maxLen);
      const lastNewline = content.lastIndexOf("\n");
      if (lastNewline > maxLen * 0.8) {
        content = content.slice(0, lastNewline);
      }
      truncated = true;
    }

    return {
      url: res.url || url,
      title,
      description,
      content,
      statusCode: res.status,
      contentType,
      byteLength: rawBody.length,
      truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function formatResult(result: FetchResult): string {
  const parts: string[] = [];

  if (result.title) parts.push(`# ${result.title}`);
  parts.push(`URL: ${result.url}`);
  parts.push(`Status: ${result.statusCode} | Type: ${result.contentType} | Size: ${(result.byteLength / 1024).toFixed(1)}KB`);
  if (result.description) parts.push(`Description: ${result.description}`);
  if (result.truncated) parts.push(`⚠️ Content truncated to ~${(result.content.length / 1024).toFixed(0)}KB`);

  parts.push("");
  parts.push(result.content);

  return parts.join("\n");
}
