import fs from "fs";
import path from "path";

const SKILLS_DIR = path.join(process.cwd(), "data", "skills");
const CACHE_TTL = 24 * 60 * 60 * 1000;
const GITHUB_BASE = "https://raw.githubusercontent.com/kepano/obsidian-skills/main/skills";

const SKILL_FILES: Record<string, string> = {
  "obsidian-markdown": `${GITHUB_BASE}/obsidian-markdown/SKILL.md`,
  "json-canvas": `${GITHUB_BASE}/json-canvas/SKILL.md`,
  "obsidian-bases": `${GITHUB_BASE}/obsidian-bases/SKILL.md`,
  "defuddle": `${GITHUB_BASE}/defuddle/SKILL.md`,
};

interface CachedSkill {
  content: string;
  fetchedAt: number;
}

const memoryCache: Map<string, CachedSkill> = new Map();

function ensureDir() {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

function getCachePath(name: string): string {
  return path.join(SKILLS_DIR, `${name}.md`);
}

function readDiskCache(name: string): CachedSkill | null {
  const p = getCachePath(name);
  const metaPath = p + ".meta";
  try {
    if (!fs.existsSync(p) || !fs.existsSync(metaPath)) return null;
    const content = fs.readFileSync(p, "utf-8");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    return { content, fetchedAt: meta.fetchedAt || 0 };
  } catch {
    return null;
  }
}

function writeDiskCache(name: string, content: string) {
  ensureDir();
  fs.writeFileSync(getCachePath(name), content, "utf-8");
  fs.writeFileSync(getCachePath(name) + ".meta", JSON.stringify({ fetchedAt: Date.now() }), "utf-8");
}

async function fetchSkill(name: string): Promise<string> {
  const cached = memoryCache.get(name);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.content;
  }

  const disk = readDiskCache(name);
  if (disk && Date.now() - disk.fetchedAt < CACHE_TTL) {
    memoryCache.set(name, disk);
    return disk.content;
  }

  const url = SKILL_FILES[name];
  if (!url) return "";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = await res.text();
    memoryCache.set(name, { content, fetchedAt: Date.now() });
    writeDiskCache(name, content);
    console.log(`[obsidian-skills] Fetched ${name} (${content.length} bytes)`);
    return content;
  } catch (err: any) {
    console.warn(`[obsidian-skills] Failed to fetch ${name}: ${err.message}`);
    if (disk) {
      memoryCache.set(name, disk);
      return disk.content;
    }
    return "";
  }
}

export async function loadAllSkills(): Promise<void> {
  const names = Object.keys(SKILL_FILES);
  await Promise.allSettled(names.map(n => fetchSkill(n)));
  const loaded = names.filter(n => memoryCache.has(n) && memoryCache.get(n)!.content.length > 0);
  console.log(`[obsidian-skills] Loaded ${loaded.length}/${names.length} skills: ${loaded.join(", ")}`);
}

export async function getVaultSkillsContext(): Promise<string> {
  const parts: string[] = [];
  for (const name of Object.keys(SKILL_FILES)) {
    const content = await fetchSkill(name);
    if (content) {
      parts.push(`### ${name}\n${content}`);
    }
  }
  if (parts.length === 0) return "";
  return `\n\n---\n## Obsidian Vault Formatting Guide\nWhen writing to the vault, follow these Obsidian-flavored markdown conventions:\n\n${parts.join("\n\n")}`;
}

export function hasVaultTools(toolNames: string[]): boolean {
  const vaultTools = ["notes_create", "notes_read", "notes_list", "notes_append", "notes_search", "notes_move", "notes_delete", "notes_rename_folder", "notes_list_recursive", "notes_file_info"];
  return toolNames.some(t => vaultTools.includes(t));
}
