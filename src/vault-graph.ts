export interface VaultOps {
  read: (path: string) => Promise<string>;
  list: (path: string) => Promise<string>;
  listRecursive: (path: string) => Promise<string>;
  append: (path: string, content: string) => Promise<string>;
}

let ops: VaultOps | null = null;

export function init(vaultOps: VaultOps) {
  ops = vaultOps;
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

        let linkTarget = raw.includes("|") ? raw.split("|")[0].trim() : raw;
        linkTarget = linkTarget.replace(/\\/g, "/");

        if (linkTarget.includes("..")) { i = end + 2; continue; }

        if (linkTarget.length > 0) {
          if (!linkTarget.endsWith(".md")) linkTarget += ".md";
          const key = linkTarget.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            links.push(linkTarget);
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function resolveVaultPath(link: string): Promise<string | null> {
  if (!ops) return null;

  try {
    await ops.read(link);
    return link;
  } catch {}

  const withoutExt = link.replace(/\.md$/, "");
  try {
    await ops.read(withoutExt);
    return withoutExt;
  } catch {}

  try {
    const allData = await ops.listRecursive("/");
    const parsed = JSON.parse(allData);
    const files: string[] = parsed.files || [];
    const baseName = link.split("/").pop()?.toLowerCase() || "";

    for (const f of files) {
      if (f.endsWith("/")) continue;
      const fBase = f.split("/").pop()?.toLowerCase() || "";
      if (fBase === baseName) return f;
    }
  } catch {}

  return null;
}

export async function graphContext(
  startPath: string,
  maxDepth: number = 2,
  tokenBudget: number = 30000
): Promise<{ notes: Array<{ path: string; depth: number; content: string }>; totalTokens: number; truncated: boolean }> {
  if (!ops) throw new Error("Vault graph not initialized");

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

    let content: string;
    try {
      content = await ops.read(item.notePath);
    } catch {
      continue;
    }

    const tokens = estimateTokens(content);
    if (totalTokens + tokens > tokenBudget) {
      truncated = true;
      const remaining = tokenBudget - totalTokens;
      if (remaining > 200) {
        const charLimit = remaining * 4;
        result.push({ path: item.notePath, depth: item.depth, content: content.slice(0, charLimit) + "\n\n[...truncated due to token budget]" });
        totalTokens += remaining;
      }
      break;
    }

    totalTokens += tokens;
    result.push({ path: item.notePath, depth: item.depth, content });

    if (item.depth < maxDepth) {
      const links = extractWikilinks(content);
      for (const link of links) {
        const linkNorm = link.toLowerCase();
        if (!visited.has(linkNorm)) {
          const resolved = await resolveVaultPath(link);
          if (resolved) {
            if (!visited.has(resolved.toLowerCase())) {
              queue.push({ notePath: resolved, depth: item.depth + 1 });
            }
          }
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
  if (!ops) return [];

  const newBaseName = newNotePath.split("/").pop()?.replace(/\.md$/, "").toLowerCase() || "";
  const keywords = extractKeywords(newBaseName, content);

  if (keywords.length === 0) return [];

  let allFiles: string[];
  try {
    const data = await ops.listRecursive("/");
    const parsed = JSON.parse(data);
    allFiles = (parsed.files || []).filter((f: string) => !f.endsWith("/") && f.endsWith(".md"));
  } catch {
    return [];
  }

  const newNorm = newNotePath.toLowerCase().replace(/^\/+/, "");
  const scored: Array<{ filePath: string; score: number }> = [];

  for (const filePath of allFiles) {
    if (filePath.toLowerCase() === newNorm) continue;

    const fileBaseName = filePath.split("/").pop()?.replace(/\.md$/, "").toLowerCase() || "";
    let score = 0;

    for (const kw of keywords) {
      if (fileBaseName.includes(kw)) score += 3;
    }

    const folderParts = filePath.toLowerCase().split("/").slice(0, -1);
    for (const kw of keywords) {
      for (const part of folderParts) {
        if (part.includes(kw)) { score += 1; break; }
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
  newNoteContent: string
): Promise<{ linkedTo: string[] }> {
  if (!ops) return { linkedTo: [] };

  const related = await findRelatedNotes(newNotePath, newNoteContent);
  if (related.length === 0) return { linkedTo: [] };

  const newBaseName = newNotePath.split("/").pop()?.replace(/\.md$/, "") || newNotePath;
  const newLink = `[[${newNotePath.replace(/\.md$/, "")}|${newBaseName}]]`;

  const relatedLinks = related.map(rp => {
    const rBaseName = rp.split("/").pop()?.replace(/\.md$/, "") || rp;
    return `[[${rp.replace(/\.md$/, "")}|${rBaseName}]]`;
  });

  const relatedSection = `\n\n---\n## Related Notes\n${relatedLinks.map(l => `- ${l}`).join("\n")}\n`;

  try {
    await ops.append(newNotePath, relatedSection);
    console.log(`[vault-graph] appended Related Notes section to ${newNotePath}`);
  } catch (err: any) {
    console.warn(`[vault-graph] failed to append related links to ${newNotePath}: ${err.message}`);
  }

  const backlinkLine = `\n- ${newLink}\n`;

  for (const rp of related) {
    try {
      const existingContent = await ops.read(rp);

      if (existingContent.includes(`[[${newNotePath.replace(/\.md$/, "")}`) ||
          existingContent.includes(`[[${newBaseName}]]`)) {
        continue;
      }

      const backlinkHeading = "## Backlinks";
      if (existingContent.includes(backlinkHeading)) {
        await ops.append(rp, backlinkLine);
      } else {
        await ops.append(rp, `\n\n---\n${backlinkHeading}${backlinkLine}`);
      }
      console.log(`[vault-graph] backlink added: ${rp} ← ${newBaseName}`);
    } catch (err: any) {
      console.warn(`[vault-graph] failed to add backlink to ${rp}: ${err.message}`);
    }
  }

  return { linkedTo: related };
}
