const COINBASE_API_KEY = process.env.COINBASE_API_KEY || "";
const COINBASE_API_SECRET = process.env.COINBASE_API_SECRET || "";
const COINBASE_BASE_URL = "https://api.coinbase.com/v2";

export function isConfigured(): boolean {
  return COINBASE_API_KEY.length > 0 && COINBASE_API_SECRET.length > 0;
}

async function coinbaseFetch(path: string, method: string = "GET", body?: Record<string, any>): Promise<any> {
  const url = `${COINBASE_BASE_URL}${path}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const opts: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "CB-ACCESS-KEY": COINBASE_API_KEY,
        "CB-ACCESS-SIGN": await signRequest(timestamp, method, path, body),
        "CB-ACCESS-TIMESTAMP": timestamp,
        "CB-VERSION": "2024-01-01",
      },
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Coinbase API ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function signRequest(timestamp: string, method: string, path: string, body?: Record<string, any>): Promise<string> {
  const message = timestamp + method.toUpperCase() + path + (body ? JSON.stringify(body) : "");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(COINBASE_API_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export interface CoinbaseBalance {
  currency: string;
  amount: string;
  native_amount: string;
  native_currency: string;
}

export interface SpotOrder {
  id: string;
  asset: string;
  direction: "buy" | "sell";
  amount_usd: number;
  quantity: number;
  price: number;
  status: "completed" | "pending" | "failed";
}

export async function getBalances(): Promise<CoinbaseBalance[]> {
  if (!isConfigured()) {
    console.log("[coinbase] Not configured — returning empty balances");
    return [];
  }
  try {
    const result = await coinbaseFetch("/accounts");
    return (result.data || []).map((acc: any) => ({
      currency: acc.currency?.code || acc.currency,
      amount: acc.balance?.amount || "0",
      native_amount: acc.native_balance?.amount || "0",
      native_currency: acc.native_balance?.currency || "USD",
    }));
  } catch (err) {
    console.error("[coinbase] getBalances error:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function buySpot(params: {
  asset: string;
  amount_usd: number;
}): Promise<SpotOrder> {
  if (!isConfigured()) {
    console.log(`[coinbase] SHADOW: buySpot ${params.asset} $${params.amount_usd}`);
    return {
      id: `shadow_buy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      asset: params.asset,
      direction: "buy",
      amount_usd: params.amount_usd,
      quantity: 0,
      price: 0,
      status: "completed",
    };
  }

  const accountId = await findAccountId(params.asset);
  if (!accountId) throw new Error(`No Coinbase account found for ${params.asset}`);

  const result = await coinbaseFetch(`/accounts/${accountId}/buys`, "POST", {
    amount: params.amount_usd.toString(),
    currency: "USD",
    commit: true,
  });

  return {
    id: result.data?.id || "",
    asset: params.asset,
    direction: "buy",
    amount_usd: params.amount_usd,
    quantity: parseFloat(result.data?.amount?.amount || "0"),
    price: parseFloat(result.data?.unit_price?.amount || "0"),
    status: result.data?.status === "completed" ? "completed" : "pending",
  };
}

export async function sellSpot(params: {
  asset: string;
  quantity: number;
}): Promise<SpotOrder> {
  if (!isConfigured()) {
    console.log(`[coinbase] SHADOW: sellSpot ${params.asset} qty=${params.quantity}`);
    return {
      id: `shadow_sell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      asset: params.asset,
      direction: "sell",
      amount_usd: 0,
      quantity: params.quantity,
      price: 0,
      status: "completed",
    };
  }

  const accountId = await findAccountId(params.asset);
  if (!accountId) throw new Error(`No Coinbase account found for ${params.asset}`);

  const result = await coinbaseFetch(`/accounts/${accountId}/sells`, "POST", {
    amount: params.quantity.toString(),
    currency: params.asset.toUpperCase(),
    commit: true,
  });

  return {
    id: result.data?.id || "",
    asset: params.asset,
    direction: "sell",
    amount_usd: parseFloat(result.data?.total?.amount || "0"),
    quantity: params.quantity,
    price: parseFloat(result.data?.unit_price?.amount || "0"),
    status: result.data?.status === "completed" ? "completed" : "pending",
  };
}

async function findAccountId(asset: string): Promise<string | null> {
  try {
    const result = await coinbaseFetch("/accounts");
    const accounts = result.data || [];
    const match = accounts.find((a: any) =>
      (a.currency?.code || a.currency)?.toLowerCase() === asset.toLowerCase()
    );
    return match?.id || null;
  } catch {
    return null;
  }
}
