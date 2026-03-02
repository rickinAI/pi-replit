import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

let vaultPath = "";

export function init(basePath: string) {
  vaultPath = basePath;
}

export function isConfigured(): boolean {
  if (!vaultPath) return false;
  try {
    return fsSync.existsSync(vaultPath) && fsSync.readdirSync(vaultPath).length > 0;
  } catch {
    return false;
  }
}

export function ping(): boolean {
  return isConfigured();
}

export async function listNotes(dirPath = "/"): Promise<string> {
  const resolved = resolvePath(dirPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`Path not found: ${dirPath}`);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = path.join(dirPath === "/" ? "" : dirPath, entry.name);
    files.push(entry.isDirectory() ? rel + "/" : rel);
  }
  return JSON.stringify({ files }, null, 2);
}

export async function readNote(notePath: string): Promise<string> {
  const resolved = resolvePath(notePath);
  try {
    return await fs.readFile(resolved, "utf-8");
  } catch {
    throw new Error(`Note not found: ${notePath}`);
  }
}

export async function createNote(notePath: string, content: string): Promise<string> {
  const resolved = resolvePath(notePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(resolved, content, "utf-8");
  nudgeSync(resolved);
  return `Created note: ${notePath}`;
}

export async function appendToNote(notePath: string, content: string): Promise<string> {
  const resolved = resolvePath(notePath);
  try {
    await fs.access(resolved);
  } catch {
    throw new Error(`Note not found: ${notePath}`);
  }
  await fs.appendFile(resolved, content, "utf-8");
  nudgeSync(resolved);
  return `Appended to note: ${notePath}`;
}

export async function deleteNote(notePath: string): Promise<string> {
  const resolved = resolvePath(notePath);
  try {
    await fs.access(resolved);
  } catch {
    throw new Error(`Note not found: ${notePath}`);
  }
  await fs.unlink(resolved);
  const dir = path.dirname(resolved);
  try {
    const entries = await fs.readdir(dir);
    const visible = entries.filter(e => !e.startsWith("."));
    if (visible.length === 0 && dir !== vaultPath) {
      await fs.rm(dir, { recursive: true });
    }
  } catch {}
  return `Deleted note: ${notePath}`;
}

export async function moveNote(fromPath: string, toPath: string): Promise<string> {
  const resolvedFrom = resolvePath(fromPath);
  const resolvedTo = resolvePath(toPath);
  try {
    await fs.access(resolvedFrom);
  } catch {
    throw new Error(`Note not found: ${fromPath}`);
  }
  const content = await fs.readFile(resolvedFrom, "utf-8");
  const destDir = path.dirname(resolvedTo);
  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(resolvedTo, content, "utf-8");
  await fs.unlink(resolvedFrom);
  const oldDir = path.dirname(resolvedFrom);
  try {
    const entries = await fs.readdir(oldDir);
    const visible = entries.filter(e => !e.startsWith("."));
    if (visible.length === 0 && oldDir !== vaultPath) {
      await fs.rm(oldDir, { recursive: true });
    }
  } catch {}
  nudgeSync(resolvedTo);
  return `Moved note: ${fromPath} → ${toPath}`;
}

export async function renameFolder(fromPath: string, toPath: string): Promise<string> {
  const resolvedFrom = resolvePath(fromPath.replace(/\/+$/, ""));
  const resolvedTo = resolvePath(toPath.replace(/\/+$/, ""));
  const stat = await fs.stat(resolvedFrom).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`Folder not found: ${fromPath}`);
  const destParent = path.dirname(resolvedTo);
  await fs.mkdir(destParent, { recursive: true });
  await fs.rename(resolvedFrom, resolvedTo);
  async function nudgeAll(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await nudgeAll(full);
      else nudgeSync(full);
    }
  }
  await nudgeAll(resolvedTo);
  return `Renamed folder: ${fromPath} → ${toPath}`;
}

export async function listRecursive(dirPath = "/"): Promise<string> {
  const resolved = resolvePath(dirPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`Folder not found: ${dirPath}`);
  const files: string[] = [];
  async function walk(dir: string, relBase: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        files.push(rel + "/");
        await walk(path.join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  }
  await walk(resolved, dirPath === "/" ? "" : dirPath);
  return JSON.stringify({ files }, null, 2);
}

export async function fileInfo(notePath: string): Promise<string> {
  const resolved = resolvePath(notePath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`Not found: ${notePath}`);
  return JSON.stringify({
    path: notePath,
    type: stat.isDirectory() ? "folder" : "file",
    size: stat.size,
    sizeHuman: stat.size < 1024 ? `${stat.size} B` : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)} KB` : `${(stat.size / 1048576).toFixed(1)} MB`,
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
  }, null, 2);
}

function nudgeSync(filePath: string) {
  setTimeout(async () => {
    try {
      const now = new Date();
      await fs.utimes(filePath, now, now);
    } catch {}
  }, 600);
}

export async function searchNotes(query: string): Promise<string> {
  if (!query || query.trim().length === 0) {
    return JSON.stringify([], null, 2);
  }
  const results: Array<{ filename: string; matches: Array<{ match: { start: number; end: number }; context: string }> }> = [];
  const queryLower = query.toLowerCase();

  async function walkDir(dir: string, relBase: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const promises: Promise<void>[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        promises.push(walkDir(fullPath, relPath));
      } else if (entry.name.endsWith(".md")) {
        promises.push((async () => {
          try {
            const content = await fs.readFile(fullPath, "utf-8");
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
        })());
      }
    }
    await Promise.all(promises);
  }

  await walkDir(vaultPath, "");
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
