const BNKR_API_KEY = process.env.BNKR_API_KEY || "";
const BNKR_WALLET = process.env.BNKR_WALLET_ADDRESS || "";
const BNKR_BASE_URL = process.env.BNKR_API_URL || "https://api.bnkr.com/v1";
const BNKR_PROMPT_BASE_URL = process.env.BNKR_PROMPT_API_URL || "https://api.bankr.bot";

export function isConfigured(): boolean {
  return BNKR_API_KEY.length > 0 && BNKR_WALLET.length > 0;
}

export function isPromptConfigured(): boolean {
  return BNKR_API_KEY.length > 0;
}

async function bnkrFetch(path: string, body?: Record<string, any>, retries = 3, timeoutMs = 30000): Promise<any> {
  const url = `${BNKR_BASE_URL}${path}`;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: globalThis.Response | null = null;
    try {
      const opts: RequestInit = {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${BNKR_API_KEY}`,
          "X-Wallet-Address": BNKR_WALLET,
        },
        signal: controller.signal,
      };
      if (body) opts.body = JSON.stringify(body);
      res = await fetch(url, opts);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        console.error(`[bnkr] ${path} attempt ${attempt}/${retries} TIMEOUT after ${timeoutMs}ms`);
        lastError = new Error(`BNKR API ${path} timed out after ${timeoutMs}ms`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bnkr] ${path} attempt ${attempt}/${retries} NETWORK ERROR: ${msg}`);
        lastError = new Error(`BNKR API ${path} network error: ${msg}`);
      }
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.log(`[bnkr] Retrying ${path} in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      return res.json();
    }

    const text = await res.text().catch(() => "(could not read response body)");
    const statusErr = new Error(`BNKR API ${path} HTTP ${res.status}: ${text}`);
    console.error(`[bnkr] ${path} attempt ${attempt}/${retries} HTTP ${res.status}: ${text.slice(0, 500)}`);

    if (res.status === 401 || res.status === 403) {
      console.error(`[bnkr] AUTH ERROR (${res.status}) — BNKR API key may be invalid or expired. Response: ${text.slice(0, 200)}`);
      throw statusErr;
    }
    if (res.status >= 400 && res.status < 500) {
      throw statusErr;
    }

    lastError = statusErr;
    if (attempt < retries) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.log(`[bnkr] Retrying ${path} in ${delay}ms (server error ${res.status})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error(`BNKR API ${path} failed after ${retries} attempts`);
}

async function promptFetch(path: string, method: "GET" | "POST" = "GET", body?: Record<string, any>): Promise<any> {
  const url = `${BNKR_PROMPT_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const opts: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": BNKR_API_KEY,
      },
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`BNKR Prompt API ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export interface BnkrRichData {
  chartUrl?: string;
  chartUrls?: string[];
  trendingTokens?: Array<{ symbol: string; name: string; price?: number; change24h?: number }>;
  tokenResearch?: { symbol: string; summary: string; metrics?: Record<string, any> };
  orderDetails?: Record<string, any>;
  twapId?: string;
  [key: string]: any;
}

export interface BnkrPromptResponse {
  jobId: string;
  status: "completed" | "failed" | "pending" | "processing";
  response: string;
  richData: BnkrRichData | null;
  error?: string;
}

async function submitPrompt(prompt: string): Promise<string> {
  const result = await promptFetch("/agent/prompt", "POST", {
    prompt,
    wallet: BNKR_WALLET || undefined,
  });
  return result.jobId || result.job_id || result.id;
}

async function pollJob(jobId: string, maxAttempts: number = 45, intervalMs: number = 2000): Promise<BnkrPromptResponse> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await promptFetch(`/agent/job/${jobId}`);
    const status = result.status || "pending";
    if (status === "completed") {
      return {
        jobId,
        status: "completed",
        response: result.response || result.result || "",
        richData: extractRichData(result),
      };
    }
    if (status === "failed" || status === "error") {
      return {
        jobId,
        status: "failed",
        response: "",
        richData: null,
        error: result.error || result.message || "Job failed",
      };
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return {
    jobId,
    status: "pending",
    response: "",
    richData: null,
    error: `Job ${jobId} timed out after ${maxAttempts * intervalMs / 1000}s`,
  };
}

function extractRichData(result: any): BnkrRichData | null {
  const richData: BnkrRichData = {};
  const rd = result.richData || result.rich_data || result.data || {};

  if (Array.isArray(rd)) {
    const charts = rd.filter((item: any) => item?.type === "chart" && item?.url);
    if (charts.length > 0) {
      richData.chartUrl = charts[0].url;
      richData.chartUrls = charts.map((c: any) => c.url);
    }
  } else {
    if (rd.chartUrl || rd.chart_url) {
      richData.chartUrl = rd.chartUrl || rd.chart_url;
    }
    if (rd.chartUrls || rd.chart_urls) {
      richData.chartUrls = rd.chartUrls || rd.chart_urls;
    }
    if (rd.trendingTokens || rd.trending_tokens) {
      richData.trendingTokens = rd.trendingTokens || rd.trending_tokens;
    }
    if (rd.tokenResearch || rd.token_research) {
      richData.tokenResearch = rd.tokenResearch || rd.token_research;
    }
    if (rd.orderDetails || rd.order_details) {
      richData.orderDetails = rd.orderDetails || rd.order_details;
    }
    for (const key of Object.keys(rd)) {
      if (!(key in richData)) {
        richData[key] = rd[key];
      }
    }
  }

  const responseText = result.response || result.result || "";
  if (!richData.chartUrl && typeof responseText === "string") {
    const ipfsMatch = responseText.match(/https?:\/\/[^\s)]*mypinata\.cloud\/ipfs\/[^\s)]+/i);
    const imgMatch = responseText.match(/https?:\/\/[^\s)]+\.(png|jpg|jpeg|gif|webp|svg)(\?[^\s)]*)?/i);
    if (ipfsMatch) {
      richData.chartUrl = ipfsMatch[0];
    } else if (imgMatch) {
      richData.chartUrl = imgMatch[0];
    }
  }

  if (Object.keys(richData).length === 0) return null;

  return richData;
}

export async function bnkrAnalyze(prompt: string): Promise<BnkrPromptResponse> {
  if (!isPromptConfigured()) {
    console.log(`[bnkr] SHADOW: bnkrAnalyze prompt="${prompt.slice(0, 80)}..."`);
    return {
      jobId: `shadow_prompt_${Date.now()}`,
      status: "completed",
      response: `[SHADOW] BNKR analysis not available — API key not configured. Prompt: "${prompt}"`,
      richData: null,
    };
  }

  try {
    console.log(`[bnkr] Submitting prompt: "${prompt.slice(0, 100)}..."`);
    const jobId = await submitPrompt(prompt);
    console.log(`[bnkr] Job submitted: ${jobId}`);
    const result = await pollJob(jobId);
    console.log(`[bnkr] Job ${jobId} completed: status=${result.status}, hasRichData=${!!result.richData}`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bnkr] bnkrAnalyze failed: ${msg}`);
    return {
      jobId: `error_${Date.now()}`,
      status: "failed",
      response: "",
      richData: null,
      error: msg,
    };
  }
}

export interface BnkrPolymarketOrder {
  order_id: string;
  market_id: string;
  direction: "YES" | "NO";
  amount_usd: number;
  entry_odds: number;
  status: "pending" | "filled" | "failed";
  tx_hash: string | null;
}

export async function openPolymarketPosition(params: {
  market_id: string;
  direction: "YES" | "NO";
  amount_usd: number;
}): Promise<BnkrPolymarketOrder> {
  if (!isConfigured()) {
    console.log(`[bnkr] SHADOW: openPolymarketPosition market=${params.market_id} ${params.direction} $${params.amount_usd}`);
    return {
      order_id: `shadow_pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      market_id: params.market_id,
      direction: params.direction,
      amount_usd: params.amount_usd,
      entry_odds: 0,
      status: "filled",
      tx_hash: null,
    };
  }

  try {
    console.log(`[bnkr] Opening position: market=${params.market_id} ${params.direction} $${params.amount_usd}`);
    const result = await bnkrFetch("/polymarket/open", {
      market_id: params.market_id,
      direction: params.direction,
      amount_usd: params.amount_usd,
      wallet: BNKR_WALLET,
    });
    console.log(`[bnkr] Position opened: order_id=${result.order_id} status=${result.status} tx=${result.tx_hash}`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bnkr] openPolymarketPosition FAILED: market=${params.market_id} ${params.direction} $${params.amount_usd}`);
    console.error(`[bnkr] Full error: ${msg}`);
    throw new Error(`BNKR openPosition failed for ${params.market_id} ${params.direction} $${params.amount_usd}: ${msg}`, { cause: err });
  }
}

export async function closePolymarketPosition(orderId: string): Promise<{ tx_hash: string; exit_odds: number }> {
  if (!isConfigured()) {
    console.log(`[bnkr] SHADOW: closePolymarketPosition ${orderId}`);
    return { tx_hash: "", exit_odds: 0 };
  }
  try {
    console.log(`[bnkr] Closing position: ${orderId}`);
    const result = await bnkrFetch("/polymarket/close", { order_id: orderId, wallet: BNKR_WALLET });
    console.log(`[bnkr] Position closed: ${orderId} tx=${result.tx_hash}`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bnkr] closePolymarketPosition FAILED: ${orderId} — ${msg}`);
    throw err;
  }
}

export async function getPolymarketPositions(): Promise<BnkrPolymarketOrder[]> {
  if (!isConfigured()) return [];
  return bnkrFetch("/polymarket/positions");
}

export async function getPolymarketPositionPnL(orderId: string): Promise<{ pnl: number; pnl_pct: number; current_odds: number }> {
  if (!isConfigured()) return { pnl: 0, pnl_pct: 0, current_odds: 0 };
  return bnkrFetch(`/polymarket/pnl/${orderId}`);
}

export async function testConnectivity(): Promise<{ ok: boolean; apiConfigured: boolean; promptConfigured: boolean; apiReachable: boolean; promptReachable: boolean; apiError?: string; promptError?: string }> {
  const result = {
    ok: false,
    apiConfigured: isConfigured(),
    promptConfigured: isPromptConfigured(),
    apiReachable: false,
    promptReachable: false,
    apiError: undefined as string | undefined,
    promptError: undefined as string | undefined,
  };

  if (result.apiConfigured) {
    try {
      await bnkrFetch("/polymarket/positions", undefined, 1, 10000);
      result.apiReachable = true;
    } catch (err) {
      result.apiError = err instanceof Error ? err.message : String(err);
    }
  }

  if (result.promptConfigured) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${BNKR_PROMPT_BASE_URL}/health`, { signal: controller.signal });
      clearTimeout(timer);
      result.promptReachable = res.ok || res.status < 500;
    } catch (err) {
      result.promptError = err instanceof Error ? err.message : String(err);
    }
  }

  result.ok = (result.apiConfigured && result.apiReachable) || (!result.apiConfigured && result.promptConfigured && result.promptReachable);
  console.log(`[bnkr] Connectivity test: api=${result.apiReachable} prompt=${result.promptReachable} ok=${result.ok}${result.apiError ? ` apiErr=${result.apiError}` : ""}${result.promptError ? ` promptErr=${result.promptError}` : ""}`);
  return result;
}
