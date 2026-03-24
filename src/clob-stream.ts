import WebSocket from "ws";
import { getPool } from "./db.js";

const CLOB_REST = "https://clob.polymarket.com";
const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GAMMA_API = "https://gamma-api.polymarket.com";

const REST_POLL_INTERVAL = 5 * 60 * 1000;
const WS_RECONNECT_BASE = 5000;
const WS_RECONNECT_MAX = 60000;
const WS_PING_INTERVAL = 30000;

interface PriceCallback {
  (tokenId: string, price: number): void;
}

let ws: WebSocket | null = null;
let wsConnected = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let restPollTimer: ReturnType<typeof setInterval> | null = null;
let subscribedTokenIds: Set<string> = new Set();
let onPriceUpdate: PriceCallback | null = null;
let started = false;

const tokenToTradeId = new Map<string, string>();

export function registerTradeToken(tokenId: string, tradeId: string) {
  tokenToTradeId.set(tokenId, tradeId);
}

export function unregisterTradeToken(tokenId: string) {
  tokenToTradeId.delete(tokenId);
  unsubscribe([tokenId]);
}

export function getTradeIdForToken(tokenId: string): string | undefined {
  return tokenToTradeId.get(tokenId);
}

const tokenIdCache: Map<string, { yesTokenId: string; noTokenId: string; ts: number }> = new Map();
const TOKEN_CACHE_TTL = 24 * 60 * 60 * 1000;

export async function resolveTokenIds(conditionId: string): Promise<{ yesTokenId: string; noTokenId: string } | null> {
  const cached = tokenIdCache.get(conditionId);
  if (cached && Date.now() - cached.ts < TOKEN_CACHE_TTL) {
    return { yesTokenId: cached.yesTokenId, noTokenId: cached.noTokenId };
  }

  try {
    const isHex = /^0x[0-9a-fA-F]+$/.test(conditionId);
    const url = isHex
      ? `${GAMMA_API}/markets?condition_id=${conditionId}&limit=1`
      : `${GAMMA_API}/markets/${conditionId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = isHex ? (Array.isArray(data) && data.length > 0 ? data[0] : null) : data;
    if (!raw?.tokens || !Array.isArray(raw.tokens) || raw.tokens.length < 2) return null;

    const yesToken = raw.tokens.find((t: any) => t.outcome === "Yes") || raw.tokens[0];
    const noToken = raw.tokens.find((t: any) => t.outcome === "No") || raw.tokens[1];

    const result = { yesTokenId: yesToken.token_id, noTokenId: noToken.token_id };
    tokenIdCache.set(conditionId, { ...result, ts: Date.now() });
    return result;
  } catch (err) {
    console.error(`[clob-stream] resolveTokenIds error for ${conditionId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function fetchMidpoint(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB_REST}/midpoint?token_id=${tokenId}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const mid = parseFloat(data.mid);
    return Number.isFinite(mid) ? mid : null;
  } catch {
    return null;
  }
}

function connectWebSocket() {
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

  if (subscribedTokenIds.size === 0) {
    wsConnected = false;
    return;
  }

  try {
    ws = new WebSocket(CLOB_WS);
  } catch (err) {
    console.error("[clob-stream] WebSocket constructor error:", err instanceof Error ? err.message : err);
    scheduleReconnect();
    return;
  }

  ws.on("open", () => {
    wsConnected = true;
    reconnectAttempts = 0;
    console.log(`[clob-stream] WebSocket connected, subscribing to ${subscribedTokenIds.size} tokens`);

    const ids = Array.from(subscribedTokenIds);
    ws!.send(JSON.stringify({
      type: "market",
      assets_ids: ids,
    }));

    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, WS_PING_INTERVAL);
  });

  ws.on("message", (raw: Buffer | string) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event_type === "price_change" && data.asset_id && data.price != null) {
        const price = parseFloat(data.price);
        if (Number.isFinite(price) && onPriceUpdate) {
          onPriceUpdate(data.asset_id, price);
        }
      }

      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.event_type === "price_change" && item.asset_id && item.price != null) {
            const price = parseFloat(item.price);
            if (Number.isFinite(price) && onPriceUpdate) {
              onPriceUpdate(item.asset_id, price);
            }
          }
        }
      }
    } catch {}
  });

  ws.on("close", () => {
    wsConnected = false;
    console.log("[clob-stream] WebSocket closed");
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error("[clob-stream] WebSocket error:", err.message);
    wsConnected = false;
    try { ws?.close(); } catch {}
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (subscribedTokenIds.size === 0) return;

  const delay = Math.min(WS_RECONNECT_BASE * Math.pow(2, reconnectAttempts), WS_RECONNECT_MAX);
  reconnectAttempts++;
  console.log(`[clob-stream] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

async function restPollFallback() {
  if (subscribedTokenIds.size === 0 || !onPriceUpdate) return;

  const ids = Array.from(subscribedTokenIds);
  let updated = 0;
  for (const tokenId of ids) {
    const price = await fetchMidpoint(tokenId);
    if (price != null && onPriceUpdate) {
      onPriceUpdate(tokenId, price);
      updated++;
    }
  }
  if (updated > 0) {
    console.log(`[clob-stream] REST fallback: ${updated}/${ids.length} prices updated`);
  }
}

export function subscribe(tokenIds: string[]) {
  let newTokens = false;
  for (const id of tokenIds) {
    if (!subscribedTokenIds.has(id)) {
      subscribedTokenIds.add(id);
      newTokens = true;
    }
  }

  if (newTokens && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "market",
      assets_ids: Array.from(subscribedTokenIds),
    }));
  }

  if (newTokens && !wsConnected && !reconnectTimer && started) {
    connectWebSocket();
  }
}

export function unsubscribe(tokenIds: string[]) {
  for (const id of tokenIds) {
    subscribedTokenIds.delete(id);
  }
  if (subscribedTokenIds.size === 0 && ws) {
    try { ws.close(); } catch {}
    ws = null;
    wsConnected = false;
  }
}

export function isConnected(): boolean {
  return wsConnected;
}

export function getSubscribedCount(): number {
  return subscribedTokenIds.size;
}

export async function start(callback: PriceCallback) {
  if (started) return;
  started = true;
  onPriceUpdate = callback;

  const oversight = await import("./oversight.js");
  const openTrades = await oversight.getShadowTrades("open");

  if (openTrades.length === 0) {
    console.log("[clob-stream] No open shadow trades — streaming inactive (will activate on new trades)");
    restPollTimer = setInterval(restPollFallback, REST_POLL_INTERVAL);
    return;
  }

  const tokenIds: string[] = [];
  let resolved = 0;
  let fromDb = 0;
  for (const trade of openTrades) {
    if (trade.token_id) {
      tokenIds.push(trade.token_id);
      tokenToTradeId.set(trade.token_id, trade.id);
      resolved++;
      fromDb++;
    } else if (trade.market_id) {
      const tokens = await resolveTokenIds(trade.market_id);
      if (tokens) {
        const isYes = trade.direction === "YES" || trade.direction === "LONG";
        const relevantId = isYes ? tokens.yesTokenId : tokens.noTokenId;
        tokenIds.push(relevantId);
        tokenToTradeId.set(relevantId, trade.id);
        resolved++;
        try {
          const oversightMod = await import("./oversight.js");
          await oversightMod.updateShadowTradeFields(trade.id, { token_id: relevantId });
          console.log(`[clob-stream] Backfilled token_id for ${trade.asset}: ${relevantId.slice(0, 20)}...`);
        } catch (e) {
          console.warn(`[clob-stream] Failed to backfill token_id for ${trade.asset}:`, e instanceof Error ? e.message : e);
        }
      }
    }
  }

  console.log(`[clob-stream] Resolved ${resolved}/${openTrades.length} shadow trades to CLOB token IDs (${fromDb} from DB, ${resolved - fromDb} from API)`);

  if (tokenIds.length > 0) {
    subscribe(tokenIds);
    connectWebSocket();
  }

  restPollTimer = setInterval(restPollFallback, REST_POLL_INTERVAL);
}

export function stop() {
  started = false;
  onPriceUpdate = null;

  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (restPollTimer) { clearInterval(restPollTimer); restPollTimer = null; }

  subscribedTokenIds.clear();
  wsConnected = false;
  console.log("[clob-stream] Stopped");
}
