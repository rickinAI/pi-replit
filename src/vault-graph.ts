import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

let vaultPath = "";

export function init(basePath: string) {
  vaultPath = basePath;
}

export function extractWikilinks(markdown: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  let inCodeBlock = false;
  let inInlineCode = false;

  const lines = markdown.split("\n");
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    let i = 0;
    while (i < line.length) {
      if (line[i] === "`") {
        inInlineCode = !inInlineCode;
        i++;
        continue;
      }
      if (inInlineCode) { i++; continue; }

      if (line[i] === "\\" && i + 1 < line.length && line[i + 1] === "[") {
        i += 2;
        continue;
      }

      if (line[i] === "[" && i + 1 < line.length && line[i + 1] === "[") {
        const start = i + 2;
        const end = line.indexOf("]]", start);
        if (end === -1) { i++; continue; }

        const raw = line.substring(start, end).trim();
        if (raw.length === 0) { i = end + 2; continue; }

        const linkTarget = raw.includes("|") ? raw.split("|")[0].trim() : raw;
        if (linkTarget.length > 0) {
          const normalized = linkTarget.replace(/\\/g, "/");
          if (!seen.has(normalized.toLowerCase())) {
            seen.add(normalized.toLowerCase());
            links.push(normalized);
          }
        }
        i = end + 2;
        continue;
      }

      i++;
    }
    inInlineCode = false;
  }

  return links;
}

function resolveWikilinkPath(link: string): string | null {
  if (!vaultPath) return null;

  if (link.endsWith(".md")) {
    const resolved = path.resolve(vaultPath, link);
    if (fsSync.existsSync(resolved)) return link;
  } else {
    const withExt = link + ".md";
    const resolved = path.resolve(vaultPath, withExt);
    if (fsSync.existsSync(resolved)) return withExt;
  }

  try {
    const files = walkAllMd(vaultPath, "");
    const target = (link.endsWith(".md") ? link : link + ".md").toLowerCase();
    const baseName = path.basename(target);

    for (const f of files) {
      if (f.toLowerCase() === target) return f;
    }
    for (const f of files) {
      if (path.basename(f).toLowerCase() === baseName) return f;
    }
  } catch {}

  return null;
}

function walkAllMd(dir: string, relBase: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = fsSync.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    const rel = relBase ? path.join(relBase, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...walkAllMd(fullPath, rel));
    } else if (entry.name.endsWith(".md")) {
      results.push(rel);
    }
  }
  return results;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function graphContext(
  startPath: string,
  maxDepth: number = 2,
  tokenBudget: number = 30000
): Promise<{ notes: Array<{ path: string; depth: number; content: string }>; totalTokens: number; truncated: boolean }> {
  if (!vaultPath) throw new Error("Vault not configured");

  const visited = new Set<string>();
  const result: Array<{ path: string; depth: number; content: string }> = [];
  let totalTokens = 0;
  let truncated = false;

  const queue: Array<{ notePath: string; depth: number }> = [{ notePath: startPath, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift()!;
    const normalizedPath = item.notePath.toLowerCase();

    if (visited.has(normalizedPath)) continue;
    visited.add(normalizedPath);

    const resolved = resolveWikilinkPath(item.notePath) || item.notePath;
    const fullPath = path.resolve(vaultPath, resolved);

    let content: string;
    try {
      content = await fs.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    const tokens = estimateTokens(content);
    if (totalTokens + tokens > tokenBudget) {
      truncated = true;
      const remaining = tokenBudget - totalTokens;
      if (remaining > 200) {
        const charLimit = remaining * 4;
        result.push({ path: resolved, depth: item.depth, content: content.slice(0, charLimit) + "\n\n[...truncated due to token budget]" });
        totalTokens += remaining;
      }
      break;
    }

    totalTokens += tokens;
    result.push({ path: resolved, depth: item.depth, content });

    if (item.depth < maxDepth) {
      const links = extractWikilinks(content);
      for (const link of links) {
        const linkNorm = link.toLowerCase();
        if (!visited.has(linkNorm) && !visited.has(linkNorm + ".md") && !visited.has(linkNorm.replace(/\.md$/, ""))) {
          queue.push({ notePath: link, depth: item.depth + 1 });
        }
      }
    }
  }

  return { notes: result, totalTokens, truncated };
}

export async function findRelatedNotes(
  newNotePath: string,
  content: string,
  maxResults: number = 5
): Promise<string[]> {
  if (!vaultPath) return [];

  const newBaseName = path.basename(newNotePath, ".md").toLowerCase();
  const keywords = extractKeywords(newBaseName, content);

  if (keywords.length === 0) return [];

  const allFiles = walkAllMd(vaultPath, "");
  const newNorm = newNotePath.toLowerCase().replace(/^\/+/, "");

  const scored: Array<{ filePath: string; score: number }> = [];

  for (const filePath of allFiles) {
    if (filePath.toLowerCase() === newNorm) continue;

    const fileBaseName = path.basename(filePath, ".md").toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      if (fileBaseName.includes(kw)) {
        score += 3;
      }
    }

    const folderParts = path.dirname(filePath).toLowerCase().split(/[/\\]/);
    for (const kw of keywords) {
      for (const part of folderParts) {
        if (part.includes(kw)) {
          score += 1;
          break;
        }
      }
    }

    if (score > 0) {
      scored.push({ filePath, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map(s => s.filePath);
}

function extractKeywords(baseName: string, content: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
    "this", "that", "not", "has", "had", "have", "will", "can", "do",
    "does", "did", "been", "being", "than", "its", "my", "me", "we",
    "he", "she", "they", "them", "our", "you", "your", "what", "which",
    "who", "how", "when", "where", "why", "all", "each", "every", "both",
    "few", "more", "most", "other", "some", "such", "no", "only", "very",
    "just", "about", "up", "so", "if", "then", "new", "also", "one", "two",
    "md", "http", "https", "www", "com",
  ]);

  const words = new Set<string>();

  const nameWords = baseName
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !stopWords.has(w));

  for (const w of nameWords) words.add(w);

  const headings = content.match(/^#{1,3}\s+(.+)$/gm) || [];
  for (const h of headings.slice(0, 5)) {
    const text = h.replace(/^#+\s+/, "");
    const hWords = text
      .replace(/[-_]+/g, " ")
      .split(/\s+/)
      .map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter(w => w.length > 2 && !stopWords.has(w));
    for (const w of hWords.slice(0, 3)) words.add(w);
  }

  return Array.from(words).slice(0, 8);
}

export async function addBidirectionalLinks(
  newNotePath: string,
  content: string
): Promise<{ linkedTo: string[]; content: string }> {
  if (!vaultPath) return { linkedTo: [], content };

  const related = await findRelatedNotes(newNotePath, content);
  if (related.length === 0) return { linkedTo: [], content };

  const newBaseName = path.basename(newNotePath, ".md");
  const newLink = `[[${newNotePath.replace(/\.md$/, "")}|${newBaseName}]]`;

  const relatedLinks = related.map(rp => {
    const rBaseName = path.basename(rp, ".md");
    return `[[${rp.replace(/\.md$/, "")}|${rBaseName}]]`;
  });

  const relatedSection = `\n\n---\n## Related Notes\n${relatedLinks.map(l => `- ${l}`).join("\n")}\n`;
  const updatedContent = content + relatedSection;

  const backlinkLine = `\n- ${newLink}\n`;

  for (const rp of related) {
    const fullPath = path.resolve(vaultPath, rp);
    try {
      const existingContent = await fs.readFile(fullPath, "utf-8");

      if (existingContent.includes(`[[${newNotePath.replace(/\.md$/, "")}`) ||
          existingContent.includes(`[[${newBaseName}]]`)) {
        continue;
      }

      const backlinkHeading = "## Backlinks";
      if (existingContent.includes(backlinkHeading)) {
        const updated = existingContent.replace(
          backlinkHeading,
          backlinkHeading + backlinkLine
        );
        await fs.writeFile(fullPath, updated, "utf-8");
      } else {
        await fs.appendFile(fullPath, `\n\n---\n${backlinkHeading}${backlinkLine}`, "utf-8");
      }
      console.log(`[vault-graph] backlink added: ${rp} ← ${newBaseName}`);
    } catch (err: any) {
      console.warn(`[vault-graph] failed to add backlink to ${rp}: ${err.message}`);
    }
  }

  return { linkedTo: related, content: updatedContent };
}
