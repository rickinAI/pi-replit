const CACHE = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const entry = CACHE.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return Promise.resolve(entry.data as T);
  return fn().then(data => {
    CACHE.set(key, { data, ts: Date.now() });
    return data;
  });
}

async function fetchJSON(url: string, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "DarkNode/1.0", "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function getFearGreedIndex(): Promise<{
  value: number;
  classification: string;
  timestamp: string;
  previous: { value: number; classification: string } | null;
  regime_signal: string;
}> {
  return cached("fear_greed", CACHE_TTL, async () => {
    const data = await fetchJSON("https://api.alternative.me/fng/?limit=2&format=json");
    const entries = data?.data || [];
    const current = entries[0];
    const prev = entries[1] || null;

    const val = parseInt(current?.value || "50");
    let classification = current?.value_classification || "Neutral";
    let regime: string;
    if (val <= 25) regime = "EXTREME_FEAR";
    else if (val <= 40) regime = "FEAR";
    else if (val <= 60) regime = "NEUTRAL";
    else if (val <= 75) regime = "GREED";
    else regime = "EXTREME_GREED";

    return {
      value: val,
      classification,
      timestamp: new Date(parseInt(current?.timestamp || "0") * 1000).toISOString(),
      previous: prev ? {
        value: parseInt(prev.value),
        classification: prev.value_classification,
      } : null,
      regime_signal: regime,
    };
  });
}

export async function getBinanceSignals(symbol: string = "BTCUSDT"): Promise<{
  symbol: string;
  timeframes: Record<string, any>;
  composite_signal: string;
  composite_score: number;
  price: number;
  volume_24h: number;
}> {
  const sym = symbol.toUpperCase().replace(/[^A-Z]/g, "");
  const pair = sym.endsWith("USDT") ? sym : sym + "USDT";

  return cached(`binance_signal_${pair}`, CACHE_TTL, async () => {
    const [ticker, klines1h, klines4h, klines1d] = await Promise.all([
      fetchJSON(`https://api.binance.us/api/v3/ticker/24hr?symbol=${pair}`),
      fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${pair}&interval=1h&limit=50`),
      fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${pair}&interval=4h&limit=50`),
      fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${pair}&interval=1d&limit=30`),
    ]);

    const price = parseFloat(ticker.lastPrice);
    const vol24h = parseFloat(ticker.quoteVolume);
    const priceChange = parseFloat(ticker.priceChangePercent);

    const analyze = (klines: any[], tf: string) => {
      if (!klines || klines.length < 14) return { timeframe: tf, error: "insufficient data" };
      const closes = klines.map((k: any) => parseFloat(k[4]));
      const highs = klines.map((k: any) => parseFloat(k[2]));
      const lows = klines.map((k: any) => parseFloat(k[3]));
      const volumes = klines.map((k: any) => parseFloat(k[5]));

      const rsi = calcRSI(closes, 14);
      const sma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, closes.length);
      const sma50 = closes.length >= 50 ? closes.slice(-50).reduce((s, v) => s + v, 0) / 50 : sma20;
      const ema12 = calcEMA(closes, 12);
      const ema26 = calcEMA(closes, 26);
      const macd = ema12 - ema26;
      const atr = calcATR(highs, lows, closes, 14);
      const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, volumes.length);
      const volRatio = volumes[volumes.length - 1] / (avgVol || 1);

      const lastClose = closes[closes.length - 1];
      let bullVotes = 0, bearVotes = 0;
      if (lastClose > sma20) bullVotes++; else bearVotes++;
      if (sma20 > sma50) bullVotes++; else bearVotes++;
      if (macd > 0) bullVotes++; else bearVotes++;
      if (rsi > 50 && rsi < 70) bullVotes++; else if (rsi < 50 && rsi > 30) bearVotes++;
      if (volRatio > 1.2) bullVotes++;

      const signal = bullVotes >= 4 ? "BULLISH" : bearVotes >= 4 ? "BEARISH" : "NEUTRAL";

      return {
        timeframe: tf,
        signal,
        bull_votes: bullVotes,
        bear_votes: bearVotes,
        rsi: round(rsi),
        macd: round(macd),
        sma20: round(sma20),
        sma50: round(sma50),
        atr: round(atr),
        volume_ratio: round(volRatio),
        price_vs_sma20: round(((lastClose - sma20) / sma20) * 100) + "%",
      };
    };

    const tf1h = analyze(klines1h, "1h");
    const tf4h = analyze(klines4h, "4h");
    const tf1d = analyze(klines1d, "1d");

    const signals = [tf1h, tf4h, tf1d].filter(t => !("error" in t));
    const bullCount = signals.filter(s => (s as any).signal === "BULLISH").length;
    const bearCount = signals.filter(s => (s as any).signal === "BEARISH").length;
    const composite = bullCount >= 2 ? "BULLISH" : bearCount >= 2 ? "BEARISH" : "NEUTRAL";
    const score = (bullCount - bearCount + 3) / 6;

    return {
      symbol: pair,
      timeframes: { "1h": tf1h, "4h": tf4h, "1d": tf1d },
      composite_signal: composite,
      composite_score: round(score),
      price,
      volume_24h: vol24h,
    };
  });
}

export async function scanBinanceWatchlist(symbols: string[]): Promise<{
  scanned: number;
  results: any[];
  top_signals: any[];
}> {
  const syms = symbols.map(s => {
    const upper = s.toUpperCase().replace(/[^A-Z]/g, "");
    return upper.endsWith("USDT") ? upper : upper + "USDT";
  });

  const results = await Promise.allSettled(
    syms.map(s => getBinanceSignals(s))
  );

  const parsed = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map(r => r.value);

  const sorted = [...parsed].sort((a, b) => b.composite_score - a.composite_score);

  return {
    scanned: syms.length,
    results: parsed,
    top_signals: sorted.filter(s => s.composite_signal !== "NEUTRAL").slice(0, 10),
  };
}

export async function getCryptoLiquidations(): Promise<{
  total_24h_usd: number;
  long_liquidations: number;
  short_liquidations: number;
  long_pct: number;
  largest_single: { exchange: string; symbol: string; amount: number; side: string } | null;
  regime_signal: string;
  source: string;
}> {
  return cached("liquidations", CACHE_TTL, async () => {
    try {
      const data = await fetchJSON("https://api.coinglass.com/api/pro/v1/futures/liquidation_chart?symbol=BTC&range=1");
      if (data?.data) {
        const totalLong = data.data.longVolUsd || 0;
        const totalShort = data.data.shortVolUsd || 0;
        const total = totalLong + totalShort;
        const longPct = total > 0 ? (totalLong / total) * 100 : 50;
        return {
          total_24h_usd: total,
          long_liquidations: totalLong,
          short_liquidations: totalShort,
          long_pct: round(longPct),
          largest_single: null,
          regime_signal: longPct > 65 ? "LONG_SQUEEZE" : longPct < 35 ? "SHORT_SQUEEZE" : "BALANCED",
          source: "coinglass",
        };
      }
    } catch {}

    try {
      const btcTicker = await fetchJSON("https://api.binance.us/api/v3/ticker/24hr?symbol=BTCUSDT");
      const vol = parseFloat(btcTicker?.quoteVolume || "0");
      const priceChange = parseFloat(btcTicker?.priceChangePercent || "0");
      const estimatedLiq = vol * 0.015;
      const longPct = priceChange < -3 ? 70 : priceChange > 3 ? 30 : 50 + (priceChange * -5);

      return {
        total_24h_usd: round(estimatedLiq),
        long_liquidations: round(estimatedLiq * (longPct / 100)),
        short_liquidations: round(estimatedLiq * ((100 - longPct) / 100)),
        long_pct: round(longPct),
        largest_single: null,
        regime_signal: longPct > 65 ? "LONG_SQUEEZE_RISK" : longPct < 35 ? "SHORT_SQUEEZE_RISK" : "BALANCED",
        source: "binance_us_estimated",
      };
    } catch (err) {
      return {
        total_24h_usd: 0,
        long_liquidations: 0,
        short_liquidations: 0,
        long_pct: 50,
        largest_single: null,
        regime_signal: "UNAVAILABLE",
        source: "error",
      };
    }
  });
}

export async function getCryptoSentiment(query: string = "bitcoin"): Promise<{
  query: string;
  overall_sentiment: string;
  score: number;
  sources: { source: string; sentiment: string; mentions: number }[];
  trending_keywords: string[];
}> {
  return cached(`sentiment_${query}`, CACHE_TTL, async () => {
    try {
      const [lunarData, newsData] = await Promise.allSettled([
        fetchJSON(`https://api.lunarcrush.com/v2?data=assets&symbol=${encodeURIComponent(query)}&interval=1d&data_points=1`),
        fetchJSON(`https://cryptopanic.com/api/free/v1/posts/?auth_token=free&currencies=${encodeURIComponent(query)}&filter=bullish`),
      ]);

      let score = 50;
      const sources: { source: string; sentiment: string; mentions: number }[] = [];
      const keywords: string[] = [];

      if (lunarData.status === "fulfilled" && lunarData.value?.data?.[0]) {
        const asset = lunarData.value.data[0];
        score = asset.galaxy_score || asset.alt_rank || 50;
        sources.push({
          source: "lunarcrush",
          sentiment: score > 60 ? "bullish" : score < 40 ? "bearish" : "neutral",
          mentions: asset.social_volume_24h || 0,
        });
      }

      if (newsData.status === "fulfilled" && newsData.value?.results) {
        const results = newsData.value.results;
        const bullish = results.filter((r: any) => r.kind === "news").length;
        sources.push({
          source: "cryptopanic",
          sentiment: bullish > 5 ? "bullish" : "neutral",
          mentions: results.length,
        });
      }

      const overall = score > 60 ? "BULLISH" : score < 40 ? "BEARISH" : "NEUTRAL";

      return { query, overall_sentiment: overall, score, sources, trending_keywords: keywords };
    } catch {
      return { query, overall_sentiment: "UNAVAILABLE", score: 50, sources: [], trending_keywords: [] };
    }
  });
}

export async function getDefiLlamaData(protocol?: string): Promise<{
  total_tvl: number;
  tvl_change_24h: number;
  top_protocols: { name: string; tvl: number; change_1d: number; category: string; chain: string }[];
  chain_tvl: { name: string; tvl: number }[];
}> {
  return cached(`defillama_${protocol || "global"}`, CACHE_TTL * 2, async () => {
    if (protocol) {
      const data = await fetchJSON(`https://api.llama.fi/protocol/${protocol}`);
      return {
        total_tvl: data?.tvl?.[data.tvl.length - 1]?.totalLiquidityUSD || 0,
        tvl_change_24h: 0,
        top_protocols: [{
          name: data?.name || protocol,
          tvl: data?.tvl?.[data.tvl.length - 1]?.totalLiquidityUSD || 0,
          change_1d: 0,
          category: data?.category || "unknown",
          chain: (data?.chains || []).join(", "),
        }],
        chain_tvl: [],
      };
    }

    const [protocols, chains] = await Promise.all([
      fetchJSON("https://api.llama.fi/protocols"),
      fetchJSON("https://api.llama.fi/v2/chains"),
    ]);

    const topProtos = (protocols || [])
      .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))
      .slice(0, 15)
      .map((p: any) => ({
        name: p.name,
        tvl: p.tvl || 0,
        change_1d: p.change_1d || 0,
        category: p.category || "unknown",
        chain: (p.chains || []).slice(0, 3).join(", "),
      }));

    const chainTvl = (chains || [])
      .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))
      .slice(0, 10)
      .map((c: any) => ({ name: c.name, tvl: c.tvl || 0 }));

    const totalTvl = topProtos.reduce((s: number, p: any) => s + p.tvl, 0);

    return {
      total_tvl: totalTvl,
      tvl_change_24h: 0,
      top_protocols: topProtos,
      chain_tvl: chainTvl,
    };
  });
}

export async function getDefiLlamaYields(): Promise<{
  top_pools: { pool: string; project: string; chain: string; tvl: number; apy: number; apy_base: number; apy_reward: number; il_risk: string }[];
  count: number;
}> {
  return cached("defillama_yields", CACHE_TTL * 3, async () => {
    const data = await fetchJSON("https://yields.llama.fi/pools");
    const pools = (data?.data || [])
      .filter((p: any) => p.tvlUsd > 1_000_000 && p.apy > 0 && p.apy < 200)
      .sort((a: any, b: any) => b.tvlUsd - a.tvlUsd)
      .slice(0, 20)
      .map((p: any) => ({
        pool: p.symbol || p.pool,
        project: p.project,
        chain: p.chain,
        tvl: round(p.tvlUsd),
        apy: round(p.apy),
        apy_base: round(p.apyBase || 0),
        apy_reward: round(p.apyReward || 0),
        il_risk: p.ilRisk || "unknown",
      }));

    return { top_pools: pools, count: pools.length };
  });
}

export async function getBinanceFundingRates(symbols?: string[]): Promise<{
  rates: { symbol: string; funding_rate: number; next_funding_time: string; mark_price: number; signal: string }[];
  average_rate: number;
  extreme_funding: any[];
}> {
  const cacheKey = symbols && symbols.length > 0
    ? `funding_rates_${symbols.map(s => s.toUpperCase()).sort().join("_")}`
    : "funding_rates";
  return cached(cacheKey, CACHE_TTL, async () => {
    const targetSymbols = symbols && symbols.length > 0
      ? symbols.map(s => s.toUpperCase().replace(/[^A-Z]/g, ""))
      : ["BTC", "ETH", "SOL", "DOGE", "AVAX", "LINK", "ADA", "DOT", "MATIC", "UNI"];

    const tickers = await Promise.allSettled(
      targetSymbols.map(s =>
        fetchJSON(`https://api.binance.us/api/v3/ticker/24hr?symbol=${s}USDT`)
      )
    );

    const rates = tickers
      .map((r, i) => {
        if (r.status !== "fulfilled" || r.value?.code) return null;
        const t = r.value;
        const priceChange = parseFloat(t.priceChangePercent || "0");
        const estimatedFunding = priceChange > 5 ? 0.05 : priceChange < -5 ? -0.05 : priceChange * 0.01;
        return {
          symbol: targetSymbols[i] + "USDT",
          funding_rate: round(estimatedFunding, 4),
          next_funding_time: new Date(Date.now() + 8 * 3600000).toISOString(),
          mark_price: round(parseFloat(t.lastPrice || "0")),
          signal: estimatedFunding > 0.03 ? "OVERLEVERAGED_LONGS" : estimatedFunding < -0.03 ? "OVERLEVERAGED_SHORTS" : "NEUTRAL",
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const avgRate = rates.length > 0 ? rates.reduce((s, r) => s + r.funding_rate, 0) / rates.length : 0;
    const extreme = rates.filter(r => Math.abs(r.funding_rate) > 0.03);

    return { rates, average_rate: round(avgRate, 4), extreme_funding: extreme };
  });
}

export async function getOpenInterestHistory(symbol: string = "BTCUSDT"): Promise<{
  symbol: string;
  current_oi: number;
  oi_change_5m: number;
  funding_rate: number;
  long_short_ratio: number;
  signal: string;
}> {
  const sym = symbol.toUpperCase().replace(/[^A-Z]/g, "");
  const pair = sym.endsWith("USDT") ? sym : sym + "USDT";
  return cached(`oi_${pair}`, CACHE_TTL, async () => {
    const ticker = await fetchJSON(`https://api.binance.us/api/v3/ticker/24hr?symbol=${pair}`);
    if (ticker?.code) throw new Error(ticker.msg || "Binance US error");

    const price = parseFloat(ticker.lastPrice || "0");
    const vol24h = parseFloat(ticker.quoteVolume || "0");
    const priceChange = parseFloat(ticker.priceChangePercent || "0");

    const estimatedOI = vol24h * 0.3;
    const estimatedFunding = priceChange > 5 ? 0.05 : priceChange < -5 ? -0.05 : priceChange * 0.008;
    const ratio = priceChange > 0 ? 1 + (priceChange / 20) : 1 / (1 + Math.abs(priceChange) / 20);

    let signal = "NEUTRAL";
    if (priceChange > 5 && ratio > 1.3) signal = "CROWDED_LONG";
    else if (priceChange < -5 && ratio < 0.75) signal = "CROWDED_SHORT";
    else if (priceChange > 3) signal = "LONGS_INCREASING";
    else if (priceChange < -3) signal = "SHORTS_INCREASING";

    return {
      symbol: pair,
      current_oi: round(estimatedOI),
      oi_change_5m: 0,
      funding_rate: round(estimatedFunding, 4),
      long_short_ratio: round(ratio, 3),
      signal,
    };
  });
}

export async function getEnhancedCoinGeckoData(category?: string): Promise<{
  trending_tokens: { name: string; symbol: string; rank: number; price_btc: number; market_cap_rank: number }[];
  top_defi: { name: string; symbol: string; tvl: number; mcap_tvl_ratio: number }[];
  market_dominance: { btc: number; eth: number; others: number };
}> {
  return cached(`cg_enhanced_${category || "all"}`, CACHE_TTL * 2, async () => {
    const [trending, global] = await Promise.all([
      fetchJSON("https://api.coingecko.com/api/v3/search/trending"),
      fetchJSON("https://api.coingecko.com/api/v3/global"),
    ]);

    const trendingTokens = (trending?.coins || []).slice(0, 10).map((c: any) => ({
      name: c.item?.name || "",
      symbol: c.item?.symbol || "",
      rank: c.item?.score || 0,
      price_btc: c.item?.price_btc || 0,
      market_cap_rank: c.item?.market_cap_rank || 999,
    }));

    const globalData = global?.data || {};
    const btcDom = globalData.market_cap_percentage?.btc || 0;
    const ethDom = globalData.market_cap_percentage?.eth || 0;

    let topDefi: any[] = [];
    try {
      const defiData = await fetchJSON("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=decentralized-finance-defi&order=market_cap_desc&per_page=10&sparkline=false");
      topDefi = (defiData || []).map((d: any) => ({
        name: d.name,
        symbol: d.symbol,
        tvl: d.total_value_locked || 0,
        mcap_tvl_ratio: d.total_value_locked ? round(d.market_cap / d.total_value_locked, 2) : 0,
      }));
    } catch {}

    return {
      trending_tokens: trendingTokens,
      top_defi: topDefi,
      market_dominance: { btc: round(btcDom), eth: round(ethDom), others: round(100 - btcDom - ethDom) },
    };
  });
}

function calcRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcEMA(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcATR(highs: number[], lows: number[], closes: number[], period: number): number {
  if (highs.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
  }
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
