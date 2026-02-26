let obsidianApiUrl = process.env.OBSIDIAN_API_URL ?? "";
const OBSIDIAN_API_KEY = process.env.OBSIDIAN_API_KEY ?? "";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

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

async function fetchWithRetry(url: string, options: RequestInit = {}): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok || !RETRYABLE_STATUSES.has(res.status)) {
        return res;
      }

      lastError = new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === "AbortError") {
        lastError = new Error("Knowledge base request timed out (10s)");
      } else {
        lastError = new Error(`Knowledge base connection failed: ${err.message}`);
      }
    }

    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
    }
  }

  throw lastError!;
}

export async function ping(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseUrl()}/`, { headers: headers(), signal: controller.signal });
    clearTimeout(timeout);
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

export async function listNotes(dirPath = "/"): Promise<string> {
  const url = `${baseUrl()}/vault/${encodePath(dirPath)}`;
  const res = await fetchWithRetry(url, { headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}

export async function readNote(notePath: string): Promise<string> {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetchWithRetry(url, {
    headers: { ...headers(), Accept: "text/markdown" },
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return await res.text();
}

export async function createNote(notePath: string, content: string): Promise<string> {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetchWithRetry(url, {
    method: "PUT",
    headers: { ...headers(), "Content-Type": "text/markdown" },
    body: content,
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return `Created note: ${notePath}`;
}

export async function appendToNote(notePath: string, content: string): Promise<string> {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        ...headers(),
        "Content-Type": "text/markdown",
        "Content-Insertion-Position": "end",
      },
      body: content,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
    return `Appended to note: ${notePath}`;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Knowledge base request timed out (10s)");
    throw err;
  }
}

export async function searchNotes(query: string): Promise<string> {
  const url = `${baseUrl()}/search/simple/?query=${encodeURIComponent(query)}`;
  const res = await fetchWithRetry(url, { headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}
