import { getPool } from "./db.js";

const BNKR_API_KEY = process.env.BANKR_API_KEY || "";
const BNKR_WALLET = process.env.BANKR_WALLET_ADDRESS || "";
const BNKR_BASE_URL = process.env.BANKR_API_URL || "https://api.bnkr.com/v1";

export function isConfigured(): boolean {
  return BNKR_API_KEY.length > 0 && BNKR_WALLET.length > 0;
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
