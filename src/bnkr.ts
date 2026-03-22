const BNKR_API_KEY = process.env.BNKR_API_KEY || "";
const BNKR_WALLET = process.env.BNKR_WALLET_ADDRESS || "";
const BNKR_BASE_URL = process.env.BNKR_API_URL || "https://api.bnkr.com/v1";
const BNKR_PROMPT_BASE_URL = process.env.BNKR_PROMPT_API_URL || "https://api.bankr.bot";
const TWAP_SIZE_THRESHOLD = parseFloat(process.env.BNKR_TWAP_THRESHOLD || "500");

export function isConfigured(): boolean {
  return BNKR_API_KEY.length > 0 && BNKR_WALLET.length > 0;
}

export function isPromptConfigured(): boolean {
  return BNKR_API_KEY.length > 0;
}

async function bnkrFetch(path: string, body?: Record<string, any>): Promise<any> {
  const url = `${BNKR_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
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
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`BNKR API ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
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

export async function getChart(asset: string): Promise<{ chartUrl: string | null; analysis: string }> {
  const result = await bnkrAnalyze(`show me a technical analysis chart for ${asset}`);
  return {
    chartUrl: result.richData?.chartUrl || (result.richData?.chartUrls?.[0]) || null,
    analysis: result.response,
  };
}

export async function getTrendingTokens(): Promise<{ tokens: BnkrRichData["trendingTokens"] | undefined; analysis: string }> {
  const result = await bnkrAnalyze("what tokens are trending right now? show me the top movers");
  return {
    tokens: result.richData?.trendingTokens || undefined,
    analysis: result.response,
  };
}

export async function researchToken(token: string): Promise<{ research: BnkrRichData["tokenResearch"] | undefined; analysis: string; chartUrl: string | null }> {
  const result = await bnkrAnalyze(`give me a detailed analysis and research on ${token} including price action, fundamentals, and chart`);
  return {
    research: result.richData?.tokenResearch || undefined,
    analysis: result.response,
    chartUrl: result.richData?.chartUrl || null,
  };
}

export interface BnkrCryptoOrder {
  order_id: string;
  asset: string;
  direction: "LONG" | "SHORT";
  leverage: number;
  size: number;
  entry_price: number;
  status: "pending" | "filled" | "failed";
  tx_hash: string | null;
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

export async function openCryptoPosition(params: {
  asset: string;
  direction: "LONG" | "SHORT";
  leverage: number;
  size: number;
  stop_price: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
}): Promise<BnkrCryptoOrder> {
  if (!isConfigured()) {
    console.log(`[bnkr] SHADOW: openCryptoPosition ${params.asset} ${params.direction} ${params.leverage}x size=${params.size}`);
    return {
      order_id: `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      asset: params.asset,
      direction: params.direction,
      leverage: params.leverage,
      size: params.size,
      entry_price: 0,
      status: "filled",
      tx_hash: null,
    };
  }

  if (isPromptConfigured() && (params.stop_loss_pct || params.take_profit_pct)) {
    try {
      return await openCryptoPositionViaPrompt(params);
    } catch (err) {
      console.warn(`[bnkr] Prompt-based open failed, falling back to raw API: ${err instanceof Error ? err.message : err}`);
    }
  }

  const result = await bnkrFetch("/crypto/open", {
    asset: params.asset,
    direction: params.direction,
    leverage: params.leverage,
    size: params.size,
    stop_price: params.stop_price,
    wallet: BNKR_WALLET,
  });
  return result;
}

async function openCryptoPositionViaPrompt(params: {
  asset: string;
  direction: "LONG" | "SHORT";
  leverage: number;
  size: number;
  entry_price?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
}): Promise<BnkrCryptoOrder> {
  const dir = params.direction.toLowerCase();
  let prompt = `${dir} ${params.size.toFixed(6)} ${params.asset} with ${params.leverage}x leverage`;
  if (params.stop_loss_pct) {
    prompt += `, ${params.stop_loss_pct}% stop loss`;
  }
  if (params.take_profit_pct) {
    prompt += `, ${params.take_profit_pct}% take profit`;
  }

  console.log(`[bnkr] Opening position via prompt: "${prompt}"`);
  const result = await bnkrAnalyze(prompt);

  if (result.status === "failed") {
    throw new Error(`BNKR prompt execution failed: ${result.error}`);
  }

  const orderDetails = result.richData?.orderDetails;
  if (!orderDetails || (!orderDetails.order_id && !orderDetails.orderId)) {
    throw new Error(`BNKR prompt order returned no order details — response may be pending or unrecognized. Raw: ${result.response.slice(0, 200)}`);
  }

  return {
    order_id: orderDetails.order_id || orderDetails.orderId,
    asset: params.asset,
    direction: params.direction,
    leverage: params.leverage,
    size: params.size,
    entry_price: orderDetails.entry_price || orderDetails.entryPrice || 0,
    status: orderDetails.status || "pending",
    tx_hash: orderDetails.tx_hash || orderDetails.txHash || null,
  };
}

export async function twapOrder(params: {
  asset: string;
  direction: "buy" | "sell";
  totalAmount: number;
  durationHours: number;
  slices?: number;
}): Promise<BnkrPromptResponse> {
  const slices = params.slices || Math.max(4, Math.ceil(params.durationHours));
  const prompt = `${params.direction} $${params.totalAmount.toFixed(2)} of ${params.asset} using TWAP over ${params.durationHours} hours in ${slices} equal slices`;

  console.log(`[bnkr] TWAP order via prompt: "${prompt}"`);

  if (!isPromptConfigured()) {
    console.log(`[bnkr] SHADOW: twapOrder ${params.asset} ${params.direction} $${params.totalAmount} over ${params.durationHours}h`);
    return {
      jobId: `shadow_twap_${Date.now()}`,
      status: "completed",
      response: `[SHADOW] TWAP order: ${params.direction} $${params.totalAmount} of ${params.asset} over ${params.durationHours}h in ${slices} slices`,
      richData: null,
    };
  }

  return bnkrAnalyze(prompt);
}

export function shouldUseTwap(sizeUsd: number): boolean {
  return sizeUsd >= TWAP_SIZE_THRESHOLD;
}

export async function closeCryptoPosition(orderId: string): Promise<{ tx_hash: string; exit_price: number }> {
  if (!isConfigured()) {
    console.log(`[bnkr] SHADOW: closeCryptoPosition ${orderId}`);
    return { tx_hash: "", exit_price: 0 };
  }
  return bnkrFetch("/crypto/close", { order_id: orderId, wallet: BNKR_WALLET });
}

export async function getCryptoPositions(): Promise<BnkrCryptoOrder[]> {
  if (!isConfigured()) return [];
  return bnkrFetch("/crypto/positions");
}

export async function getCryptoPositionPnL(orderId: string): Promise<{ pnl: number; pnl_pct: number; current_price: number }> {
  if (!isConfigured()) return { pnl: 0, pnl_pct: 0, current_price: 0 };
  return bnkrFetch(`/crypto/pnl/${orderId}`);
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

  return bnkrFetch("/polymarket/open", {
    market_id: params.market_id,
    direction: params.direction,
    amount_usd: params.amount_usd,
    wallet: BNKR_WALLET,
  });
}

export async function closePolymarketPosition(orderId: string): Promise<{ tx_hash: string; exit_odds: number }> {
  if (!isConfigured()) {
    console.log(`[bnkr] SHADOW: closePolymarketPosition ${orderId}`);
    return { tx_hash: "", exit_odds: 0 };
  }
  return bnkrFetch("/polymarket/close", { order_id: orderId, wallet: BNKR_WALLET });
}

export async function getPolymarketPositions(): Promise<BnkrPolymarketOrder[]> {
  if (!isConfigured()) return [];
  return bnkrFetch("/polymarket/positions");
}

export async function getPolymarketPositionPnL(orderId: string): Promise<{ pnl: number; pnl_pct: number; current_odds: number }> {
  if (!isConfigured()) return { pnl: 0, pnl_pct: 0, current_odds: 0 };
  return bnkrFetch(`/polymarket/pnl/${orderId}`);
}
