let obsidianApiUrl = process.env.OBSIDIAN_API_URL ?? "";
const OBSIDIAN_API_KEY = process.env.OBSIDIAN_API_KEY ?? "";

export function setApiUrl(url: string) {
  obsidianApiUrl = url.replace(/\/+$/, "");
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${OBSIDIAN_API_KEY}`,
    Accept: "application/json",
  };
}

function baseUrl(): string {
  return obsidianApiUrl.replace(/\/+$/, "");
}

function encodePath(p: string): string {
  return p.replace(/^\//, "").split("/").map(encodeURIComponent).join("/");
}

export function isConfigured(): boolean {
  return !!(obsidianApiUrl && OBSIDIAN_API_KEY);
}

export async function listNotes(dirPath = "/"): Promise<string> {
  const url = `${baseUrl()}/vault/${encodePath(dirPath)}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}

export async function readNote(notePath: string): Promise<string> {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetch(url, {
    headers: { ...headers(), Accept: "text/markdown" },
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return await res.text();
}

export async function createNote(notePath: string, content: string): Promise<string> {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers(), "Content-Type": "text/markdown" },
    body: content,
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return `Created note: ${notePath}`;
}

export async function appendToNote(notePath: string, content: string): Promise<string> {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...headers(),
      "Content-Type": "text/markdown",
      "Content-Insertion-Position": "end",
    },
    body: content,
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return `Appended to note: ${notePath}`;
}

export async function searchNotes(query: string): Promise<string> {
  const url = `${baseUrl()}/search/simple/?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}
