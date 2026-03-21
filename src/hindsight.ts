const BASE_URL = "https://api.vectorize.io/v1";
const TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

interface HindsightConfig {
  apiKey: string;
  organizationId: string;
  knowledgeBaseId: string;
}

interface RetainParams {
  text: string;
  metadata?: Record<string, string>;
}

interface RecallParams {
  query: string;
  topK?: number;
}

interface RecallResult {
  memories: Array<{
    text: string;
    score: number;
    metadata?: Record<string, string>;
    createdAt?: string;
  }>;
}

interface ReflectResult {
  summary: string;
  patterns: string[];
  insights: string[];
}

function getConfig(): HindsightConfig | null {
  const apiKey = process.env.VECTORIZE_API_KEY;
  const organizationId = process.env.VECTORIZE_ORG_ID;
  const knowledgeBaseId = process.env.VECTORIZE_KB_ID;
  if (!apiKey || !organizationId || !knowledgeBaseId) return null;
  return { apiKey, organizationId, knowledgeBaseId };
}

export function isConfigured(): boolean {
  return getConfig() !== null;
}

async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
  retries = MAX_RETRIES
): Promise<any> {
  const config = getConfig();
  if (!config) throw new Error("Hindsight not configured: missing VECTORIZE_API_KEY, VECTORIZE_ORG_ID, or VECTORIZE_KB_ID");

  const url = `${BASE_URL}/org/${config.organizationId}/knowledgebases/${config.knowledgeBaseId}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Authorization": config.apiKey,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (retries > 0 && (res.status === 429 || res.status >= 500)) {
        const delay = res.status === 429 ? 2000 : 1000;
        await new Promise(r => setTimeout(r, delay));
        return apiRequest(method, path, body, retries - 1);
      }
      throw new Error(`Hindsight API ${res.status}: ${text.slice(0, 200)}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return await res.json();
    }
    return await res.text();
  } catch (err: any) {
    if (err.name === "AbortError") {
      if (retries > 0) return apiRequest(method, path, body, retries - 1);
      throw new Error("Hindsight API timeout");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function retain(params: RetainParams): Promise<boolean> {
  try {
    await apiRequest("POST", "/memory", {
      text: params.text,
      metadata: params.metadata || {},
    });
    return true;
  } catch (err) {
    console.error("[hindsight] retain failed:", err);
    return false;
  }
}

export async function retainBatch(items: RetainParams[]): Promise<number> {
  let succeeded = 0;
  for (const item of items) {
    const ok = await retain(item);
    if (ok) succeeded++;
  }
  return succeeded;
}

export async function recall(params: RecallParams): Promise<RecallResult> {
  try {
    const data = await apiRequest("POST", "/memory/retrieve", {
      question: params.query,
      topK: params.topK || 10,
    });

    const memories = Array.isArray(data)
      ? data.map((m: any) => ({
          text: m.text || m.content || "",
          score: m.score || m.similarity || 0,
          metadata: m.metadata || {},
          createdAt: m.createdAt || m.created_at || undefined,
        }))
      : Array.isArray(data?.results)
        ? data.results.map((m: any) => ({
            text: m.text || m.content || "",
            score: m.score || m.similarity || 0,
            metadata: m.metadata || {},
            createdAt: m.createdAt || m.created_at || undefined,
          }))
        : [];

    return { memories };
  } catch (err) {
    console.error("[hindsight] recall failed:", err);
    return { memories: [] };
  }
}

export async function reflect(): Promise<ReflectResult> {
  try {
    const data = await apiRequest("POST", "/memory/reflect", {});

    if (data && typeof data === "object") {
      return {
        summary: data.summary || data.text || "Reflection complete.",
        patterns: Array.isArray(data.patterns) ? data.patterns : [],
        insights: Array.isArray(data.insights) ? data.insights : [],
      };
    }

    return await reflectLocal();
  } catch (err: any) {
    if (err?.message?.includes("404") || err?.message?.includes("405") || err?.message?.includes("not found")) {
      console.warn("[hindsight] reflect endpoint not available, using local fallback");
      return await reflectLocal();
    }
    console.error("[hindsight] reflect failed:", err);
    return { summary: "Reflection failed", patterns: [], insights: [] };
  }
}

async function reflectLocal(): Promise<ReflectResult> {
  try {
    const recent = await recall({ query: "What are the most important things I've been working on and thinking about recently?", topK: 50 });

    if (recent.memories.length === 0) {
      return { summary: "No memories stored yet.", patterns: [], insights: [] };
    }

    const memoryTexts = recent.memories.map(m => m.text);

    const categories: Record<string, string[]> = {};
    for (const text of memoryTexts) {
      const lower = text.toLowerCase();
      let cat = "general";
      if (lower.includes("project") || lower.includes("work") || lower.includes("moody")) cat = "work";
      else if (lower.includes("family") || lower.includes("baby") || lower.includes("pooja") || lower.includes("reya")) cat = "family";
      else if (lower.includes("trade") || lower.includes("crypto") || lower.includes("invest") || lower.includes("market")) cat = "finance";
      else if (lower.includes("health") || lower.includes("exercise") || lower.includes("diet")) cat = "health";
      else if (lower.includes("house") || lower.includes("property") || lower.includes("real estate")) cat = "housing";

      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(text);
    }

    const patterns: string[] = [];
    for (const [cat, items] of Object.entries(categories)) {
      if (items.length >= 3) {
        patterns.push(`${cat}: ${items.length} related memories (frequent topic)`);
      }
    }

    const insights: string[] = [];
    if (categories["work"]?.length >= 5) insights.push("Heavy work focus detected — consider work-life balance check");
    if (categories["finance"]?.length >= 3) insights.push("Active financial decision-making period");
    if (categories["family"]?.length >= 3) insights.push("Family-focused period — priorities are shifting toward family matters");

    const summary = `Memory digest: ${recent.memories.length} memories analyzed across ${Object.keys(categories).length} categories. ${patterns.length} recurring patterns detected.`;

    return { summary, patterns, insights };
  } catch (err) {
    console.error("[hindsight] reflectLocal failed:", err);
    return { summary: "Reflection failed", patterns: [], insights: [] };
  }
}
