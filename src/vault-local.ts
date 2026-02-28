import fs from "fs";
import path from "path";

let vaultPath = "";

export function init(basePath: string) {
  vaultPath = basePath;
}

export function isConfigured(): boolean {
  if (!vaultPath) return false;
  try {
    return fs.existsSync(vaultPath) && fs.readdirSync(vaultPath).length > 0;
  } catch {
    return false;
  }
}

export function ping(): boolean {
  return isConfigured();
}

export function listNotes(dirPath = "/"): string {
  const resolved = resolvePath(dirPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path not found: ${dirPath}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const files: Array<{ path: string; type: "file" | "folder" }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = path.join(dirPath === "/" ? "" : dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push({ path: rel + "/", type: "folder" });
    } else {
      files.push({ path: rel, type: "file" });
    }
  }
  return JSON.stringify({ files }, null, 2);
}

export function readNote(notePath: string): string {
  const resolved = resolvePath(notePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Note not found: ${notePath}`);
  }
  return fs.readFileSync(resolved, "utf-8");
}

export function createNote(notePath: string, content: string): string {
  const resolved = resolvePath(notePath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, content, "utf-8");
  return `Created note: ${notePath}`;
}

export function appendToNote(notePath: string, content: string): string {
  const resolved = resolvePath(notePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Note not found: ${notePath}`);
  }
  fs.appendFileSync(resolved, content, "utf-8");
  return `Appended to note: ${notePath}`;
}

export function searchNotes(query: string): string {
  if (!query || query.trim().length === 0) {
    return JSON.stringify([], null, 2);
  }
  const results: Array<{ filename: string; matches: Array<{ match: { start: number; end: number }; context: string }> }> = [];
  const queryLower = query.toLowerCase();

  function walkDir(dir: string, relBase: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walkDir(fullPath, relPath);
      } else if (entry.name.endsWith(".md")) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const contentLower = content.toLowerCase();
          const matches: Array<{ match: { start: number; end: number }; context: string }> = [];
          let idx = 0;
          while ((idx = contentLower.indexOf(queryLower, idx)) !== -1) {
            const start = Math.max(0, idx - 50);
            const end = Math.min(content.length, idx + query.length + 50);
            matches.push({
              match: { start: idx, end: idx + query.length },
              context: content.substring(start, end),
            });
            idx += query.length;
            if (matches.length >= 5) break;
          }
          if (matches.length > 0) {
            results.push({ filename: relPath, matches });
          }
        } catch {}
      }
    }
  }

  walkDir(vaultPath, "");
  return JSON.stringify(results, null, 2);
}

function resolvePath(p: string): string {
  const cleaned = p.replace(/^\/+/, "");
  const resolved = path.resolve(vaultPath, cleaned);
  const relative = path.relative(vaultPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path traversal not allowed");
  }
  return resolved;
}
