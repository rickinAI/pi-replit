const BNKR_API_KEY = process.env.BNKR_API_KEY || "";
const BNKR_WALLET = process.env.BNKR_WALLET_ADDRESS || "";
const BNKR_BASE_URL = process.env.BNKR_API_URL || "https://api.bankr.bot";

export function isConfigured(): boolean {
  return BNKR_API_KEY.length > 0 && BNKR_WALLET.length > 0;
}

export function isPromptConfigured(): boolean {
  return BNKR_API_KEY.length > 0;
}

async function promptFetch(path: string, method: "GET" | "POST" = "GET", body?: Record<string, any>, timeoutMs = 30000): Promise<any> {
  const url = `${BNKR_BASE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      const text = await res.text().catch(() => "(could not read response body)");
      console.error(`[bnkr] ${method} ${path} HTTP ${res.status}: ${text.slice(0, 500)}`);
      if (res.status === 401 || res.status === 403) {
        console.error(`[bnkr] AUTH ERROR (${res.status}) — BNKR API key may be invalid or expired`);
      }
      throw new Error(`BNKR API ${path} HTTP ${res.status}: ${text}`);
    }
    return res.json();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("BNKR API")) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[bnkr] ${method} ${path} TIMEOUT after ${timeoutMs}ms`);
      throw new Error(`BNKR API ${path} timed out after ${timeoutMs}ms`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bnkr] ${method} ${path} NETWORK ERROR: ${msg}`);
    throw new Error(`BNKR API ${path} network error: ${msg}`);
  } finally {
    clearTimeout(timer);
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
  const jobId = result.jobId || result.job_id || result.id;
  if (!jobId) {
    console.error(`[bnkr] submitPrompt: no jobId in response:`, JSON.stringify(result).slice(0, 300));
    throw new Error(`BNKR submitPrompt returned no jobId: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return jobId;
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
        response: result.response || "",
        richData: null,
        error: result.error || result.message || "Job failed",
      };
    }
    if (attempt % 10 === 9) {
      console.log(`[bnkr] pollJob ${jobId}: still ${status} after ${(attempt + 1) * intervalMs / 1000}s...`);
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
  bnkr_job_id?: string;
  bnkr_response?: string;
}

export async function openPolymarketPosition(params: {
  market_id: string;
  market_question?: string;
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

  const marketRef = params.market_question || params.market_id;
  const prompt = `bet $${params.amount_usd.toFixed(2)} on ${params.direction} for "${marketRef}" on polymarket`;

  try {
    console.log(`[bnkr] Opening position via prompt: market=${params.market_id} ${params.direction} $${params.amount_usd}`);
    console.log(`[bnkr] Prompt: "${prompt}"`);

    const jobId = await submitPrompt(prompt);
    console.log(`[bnkr] Trade job submitted: ${jobId}`);

    const result = await pollJob(jobId, 60, 2000);
    console.log(`[bnkr] Trade job ${jobId}: status=${result.status} response="${(result.response || "").slice(0, 200)}"`);

    if (result.status === "failed") {
      const errDetail = result.error || result.response || "Unknown BNKR error";
      console.error(`[bnkr] openPolymarketPosition FAILED via prompt API: ${errDetail}`);
      throw new Error(`BNKR trade failed: ${errDetail}`);
    }

    if (result.status === "pending") {
      console.error(`[bnkr] openPolymarketPosition TIMED OUT: job ${jobId} still pending after 120s`);
      throw new Error(`BNKR trade timed out: job ${jobId} still pending after 120s`);
    }

    const txMatch = result.response?.match(/0x[a-fA-F0-9]{64}/);
    const oddsMatch = result.response?.match(/(\d+(?:\.\d+)?)\s*(?:cents?|¢)/i);

    return {
      order_id: jobId,
      market_id: params.market_id,
      direction: params.direction,
      amount_usd: params.amount_usd,
      entry_odds: oddsMatch ? parseFloat(oddsMatch[1]) / 100 : 0,
      status: "filled",
      tx_hash: txMatch ? txMatch[0] : null,
      bnkr_job_id: jobId,
      bnkr_response: result.response?.slice(0, 500),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bnkr] openPolymarketPosition FAILED: market=${params.market_id} ${params.direction} $${params.amount_usd}`);
    console.error(`[bnkr] Full error: ${msg}`);
    throw new Error(`BNKR openPosition failed for ${params.market_id} ${params.direction} $${params.amount_usd}: ${msg}`, { cause: err });
  }
}

export async function closePolymarketPosition(orderId: string, marketQuestion?: string): Promise<{ tx_hash: string; exit_odds: number; bnkr_response?: string }> {
  if (!isConfigured()) {
    console.log(`[bnkr] SHADOW: closePolymarketPosition ${orderId}`);
    return { tx_hash: "", exit_odds: 0 };
  }

  const marketRef = marketQuestion || orderId;
  const prompt = `sell all my shares in "${marketRef}" on polymarket`;

  try {
    console.log(`[bnkr] Closing position via prompt: ${orderId}`);
    console.log(`[bnkr] Prompt: "${prompt}"`);

    const jobId = await submitPrompt(prompt);
    console.log(`[bnkr] Close job submitted: ${jobId}`);

    const result = await pollJob(jobId, 60, 2000);
    console.log(`[bnkr] Close job ${jobId}: status=${result.status} response="${(result.response || "").slice(0, 200)}"`);

    if (result.status === "failed") {
      const errDetail = result.error || result.response || "Unknown BNKR error";
      throw new Error(`BNKR close failed (job ${jobId}): ${errDetail}`);
    }

    if (result.status === "pending") {
      console.error(`[bnkr] closePolymarketPosition TIMED OUT: job ${jobId} still pending after 120s`);
      throw new Error(`BNKR close timed out: job ${jobId} still pending after 120s`);
    }

    const txMatch = result.response?.match(/0x[a-fA-F0-9]{64}/);
    const oddsMatch = result.response?.match(/(\d+(?:\.\d+)?)\s*(?:cents?|¢)/i);

    return {
      tx_hash: txMatch ? txMatch[0] : "",
      exit_odds: oddsMatch ? parseFloat(oddsMatch[1]) / 100 : 0,
      bnkr_response: result.response?.slice(0, 500),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bnkr] closePolymarketPosition FAILED: ${orderId} — ${msg}`);
    throw new Error(`BNKR closePosition failed for ${orderId}: ${msg}`, { cause: err });
  }
}

export async function getPolymarketPositions(): Promise<BnkrPolymarketOrder[]> {
  if (!isConfigured()) return [];
  try {
    const result = await bnkrAnalyze("show my current polymarket positions and balances");
    if (result.status === "completed" && result.response) {
      console.log(`[bnkr] getPositions response: "${result.response.slice(0, 300)}"`);
    }
    return [];
  } catch {
    return [];
  }
}

export async function getPolymarketPositionPnL(orderId: string): Promise<{ pnl: number; pnl_pct: number; current_odds: number }> {
  if (!isConfigured()) return { pnl: 0, pnl_pct: 0, current_odds: 0 };
  return { pnl: 0, pnl_pct: 0, current_odds: 0 };
}

export async function checkBalance(): Promise<{ response: string; jobId: string }> {
  if (!isConfigured()) {
    return { response: "[SHADOW] BNKR not configured", jobId: "shadow" };
  }
  try {
    console.log(`[bnkr] Checking USDC balance on Polygon...`);
    const jobId = await submitPrompt("what is my USDC balance on polygon?");
    const result = await pollJob(jobId, 30, 2000);
    console.log(`[bnkr] Balance check: status=${result.status} response="${(result.response || "").slice(0, 300)}"`);
    return { response: result.response || result.error || "no response", jobId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bnkr] Balance check failed: ${msg}`);
    return { response: `ERROR: ${msg}`, jobId: "error" };
  }
}

export async function testConnectivity(): Promise<{ ok: boolean; apiConfigured: boolean; promptConfigured: boolean; apiReachable: boolean; promptReachable: boolean; apiError?: string; promptError?: string; balanceResponse?: string }> {
  const result = {
    ok: false,
    apiConfigured: isConfigured(),
    promptConfigured: isPromptConfigured(),
    apiReachable: false,
    promptReachable: false,
    apiError: undefined as string | undefined,
    promptError: undefined as string | undefined,
    balanceResponse: undefined as string | undefined,
  };

  if (result.promptConfigured) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${BNKR_BASE_URL}/health`, {
        signal: controller.signal,
        headers: { "X-API-Key": BNKR_API_KEY },
      });
      clearTimeout(timer);
      result.promptReachable = res.ok || res.status < 500;
      if (res.status === 401 || res.status === 403) {
        result.promptError = `AUTH ERROR: HTTP ${res.status} — API key may be invalid or expired`;
        result.promptReachable = false;
      }
    } catch (err) {
      result.promptError = err instanceof Error ? err.message : String(err);
    }
  }

  result.apiConfigured = result.promptConfigured;
  result.apiReachable = result.promptReachable;
  result.apiError = result.promptError;

  result.ok = result.promptConfigured && result.promptReachable;
  console.log(`[bnkr] Connectivity test: prompt=${result.promptReachable} ok=${result.ok}${result.promptError ? ` err=${result.promptError}` : ""}`);
  return result;
}
