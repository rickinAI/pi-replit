const TIMEOUT_MS = 15_000;
const BASE_URL = "https://api.dexscreener.com";

async function dsFetch(urlPath: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${urlPath}`, {
      headers: { "User-Agent": "darknode/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`DexScreener API error ${res.status}: ${res.statusText}`);
    return await res.json();
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("DexScreener request timed out");
    throw err;
  }
}

export interface DexPair {
  chain: string;
  dexId: string;
  pairAddress: string;
  baseToken: { symbol: string; name: string; address: string };
  quoteToken: { symbol: string; name: string };
  priceUsd: number;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
  volume24h: number;
  liquidity: number;
  fdv: number | null;
  pairCreatedAt: string | null;
}

function parsePair(p: any): DexPair {
  return {
    chain: p.chainId || "",
    dexId: p.dexId || "",
    pairAddress: p.pairAddress || "",
    baseToken: {
      symbol: p.baseToken?.symbol?.toUpperCase() || "",
      name: p.baseToken?.name || "",
      address: p.baseToken?.address || "",
    },
    quoteToken: {
      symbol: p.quoteToken?.symbol?.toUpperCase() || "",
      name: p.quoteToken?.name || "",
    },
    priceUsd: parseFloat(p.priceUsd) || 0,
    priceChange5m: p.priceChange?.m5 ?? null,
    priceChange1h: p.priceChange?.h1 ?? null,
    priceChange6h: p.priceChange?.h6 ?? null,
    priceChange24h: p.priceChange?.h24 ?? null,
    volume24h: p.volume?.h24 || 0,
    liquidity: p.liquidity?.usd || 0,
    fdv: p.fdv ?? null,
    pairCreatedAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
  };
}

export async function searchPairs(query: string): Promise<{ pairs: DexPair[] }> {
  const data = await dsFetch(`/latest/dex/search?q=${encodeURIComponent(query)}`);
  const pairs = (data.pairs || []).slice(0, 20).map(parsePair);
  return { pairs };
}

export async function getTokenPairs(chainId: string, tokenAddress: string): Promise<{ pairs: DexPair[] }> {
  const data = await dsFetch(`/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`);
  const pairs = (Array.isArray(data) ? data : data.pairs || []).slice(0, 20).map(parsePair);
  return { pairs };
}

export async function getTopBoostedTokens(): Promise<{
  tokens: Array<{
    chain: string;
    tokenAddress: string;
    totalAmount: number;
    url: string;
  }>;
}> {
  const data = await dsFetch("/token-boosts/top/v1");
  const tokens = (Array.isArray(data) ? data : []).slice(0, 20).map((t: any) => ({
    chain: t.chainId || "",
    tokenAddress: t.tokenAddress || "",
    totalAmount: t.totalAmount || 0,
    url: t.url || "",
  }));
  return { tokens };
}

export async function getLatestTokenProfiles(): Promise<{
  tokens: Array<{
    chain: string;
    tokenAddress: string;
    symbol: string;
    description: string;
    url: string;
  }>;
}> {
  const data = await dsFetch("/token-profiles/latest/v1");
  const tokens = (Array.isArray(data) ? data : []).slice(0, 20).map((t: any) => ({
    chain: t.chainId || "",
    tokenAddress: t.tokenAddress || "",
    symbol: t.header?.split(" ")[0] || "",
    description: t.description || "",
    url: t.url || "",
  }));
  return { tokens };
}

export interface TrendingToken {
  chain: string;
  dexId: string;
  symbol: string;
  name: string;
  tokenAddress: string;
  priceUsd: number;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
  volume24h: number;
  liquidity: number;
  fdv: number | null;
  pairCreatedAt: string | null;
}

export async function getTrendingPairs(chain?: string): Promise<{ trending: TrendingToken[] }> {
  const query = chain ? `?chain=${encodeURIComponent(chain)}` : "";
  let pairs: any[];
  try {
    const data = await dsFetch(`/token-boosts/latest/v1`);
    const boosts = (Array.isArray(data) ? data : []).slice(0, 15);

    const pairResults: DexPair[] = [];
    for (const boost of boosts) {
      if (!boost.chainId || !boost.tokenAddress) continue;
      try {
        const tokenData = await dsFetch(`/tokens/v1/${boost.chainId}/${boost.tokenAddress}`);
        const tokenPairs = (Array.isArray(tokenData) ? tokenData : tokenData.pairs || []);
        if (tokenPairs.length > 0) {
          const best = tokenPairs.sort((a: any, b: any) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0];
          pairResults.push(parsePair(best));
        }
      } catch {}
    }
    pairs = pairResults;
  } catch {
    pairs = [];
  }

  const trending: TrendingToken[] = pairs
    .filter((p: any) => !chain || p.chain === chain)
    .map((p: any) => ({
      chain: p.chain,
      dexId: p.dexId,
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      tokenAddress: p.baseToken.address,
      priceUsd: p.priceUsd,
      priceChange5m: p.priceChange5m,
      priceChange1h: p.priceChange1h,
      priceChange6h: p.priceChange6h,
      priceChange24h: p.priceChange24h,
      volume24h: p.volume24h,
      liquidity: p.liquidity,
      fdv: p.fdv,
      pairCreatedAt: p.pairCreatedAt,
    }));

  return { trending };
}

export async function getPairsByChain(chainId: string): Promise<{ pairs: DexPair[] }> {
  const data = await dsFetch(`/latest/dex/pairs/${encodeURIComponent(chainId)}`);
  const pairs = (data.pairs || []).slice(0, 30).map(parsePair);
  return { pairs };
}
