const TIMEOUT_MS = 10_000;

const CRYPTO_ALIASES: Record<string, string> = {
  btc: "bitcoin", bitcoin: "bitcoin",
  eth: "ethereum", ethereum: "ethereum",
  sol: "solana", solana: "solana",
  doge: "dogecoin", dogecoin: "dogecoin",
  ada: "cardano", cardano: "cardano",
  xrp: "ripple", ripple: "ripple",
  dot: "polkadot", polkadot: "polkadot",
  matic: "matic-network", polygon: "matic-network",
  avax: "avalanche-2", avalanche: "avalanche-2",
  link: "chainlink", chainlink: "chainlink",
  bnb: "binancecoin", binancecoin: "binancecoin",
  ltc: "litecoin", litecoin: "litecoin",
  shib: "shiba-inu",
  uni: "uniswap", uniswap: "uniswap",
  atom: "cosmos", cosmos: "cosmos",
  near: "near",
  apt: "aptos", aptos: "aptos",
  arb: "arbitrum", arbitrum: "arbitrum",
  op: "optimism", optimism: "optimism",
  sui: "sui",
  pepe: "pepe",
};

async function fetchWithTimeout(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pi-assistant/1.0", ...headers },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Request timed out");
    throw err;
  }
}

function formatNum(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatPrice(n: number): string {
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toFixed(6)}`;
}

export async function getStockQuote(symbol: string): Promise<string> {
  try {
    const ticker = symbol.toUpperCase().trim();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d&includePrePost=false`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      if (res.status === 404) return `Could not find stock symbol "${ticker}". Try using the ticker symbol (e.g. AAPL, TSLA, MSFT).`;
      throw new Error(`Yahoo Finance error ${res.status}`);
    }

    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return `No data found for "${ticker}".`;

    const meta = result.meta;
    const price = meta.regularMarketPrice;
    if (price == null) return `No price data available for "${ticker}". The market may be closed or the symbol may be invalid.`;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const currency = meta.currency || "USD";
    const exchange = meta.exchangeName || "";
    const name = meta.shortName || meta.longName || ticker;

    const change = prevClose ? price - prevClose : 0;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
    const arrow = change >= 0 ? "▲" : "▼";
    const sign = change >= 0 ? "+" : "";

    const indicators = result.indicators?.quote?.[0];
    const volumes = indicators?.volume || [];
    const lastVolume = volumes.filter((v: any) => v != null).pop();

    const lines = [
      `${name} (${ticker}) — ${exchange}`,
      `Price: ${formatPrice(price)} ${currency}`,
      `Change: ${sign}${change.toFixed(2)} (${sign}${changePct.toFixed(2)}%) ${arrow}`,
    ];

    if (prevClose) lines.push(`Prev Close: ${formatPrice(prevClose)}`);

    const timestamps = result.timestamp || [];
    const closes = indicators?.close || [];
    if (timestamps.length > 0 && closes.length > 0) {
      const highs = indicators?.high || [];
      const lows = indicators?.low || [];
      const lastIdx = closes.length - 1;
      if (highs[lastIdx] != null && lows[lastIdx] != null) lines.push(`Day Range: ${formatPrice(lows[lastIdx])} – ${formatPrice(highs[lastIdx])}`);
    }

    if (lastVolume) lines.push(`Volume: ${lastVolume.toLocaleString("en-US")}`);

    const marketState = meta.marketState || "";
    if (marketState && marketState !== "REGULAR") {
      lines.push(`Market: ${marketState.replace(/_/g, " ").toLowerCase()}`);
    }

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Stock quote error:", msg);
    return `Unable to get stock quote for "${symbol}": ${msg}`;
  }
}

export async function getCryptoPrice(coin: string): Promise<string> {
  try {
    const input = coin.toLowerCase().trim();
    const coinId = CRYPTO_ALIASES[input] || input;

    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      if (res.status === 404) {
        const searchUrl = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(input)}`;
        const searchRes = await fetchWithTimeout(searchUrl);
        if (searchRes.ok) {
          const searchData = await searchRes.json() as any;
          const coins = searchData.coins?.slice(0, 5);
          if (coins?.length > 0) {
            const suggestions = coins.map((c: any) => `${c.name} (${c.symbol.toUpperCase()})`).join(", ");
            return `Could not find "${coin}". Did you mean: ${suggestions}?`;
          }
        }
        return `Could not find cryptocurrency "${coin}". Try using the full name (e.g. "bitcoin") or ticker (e.g. "BTC").`;
      }
      throw new Error(`CoinGecko error ${res.status}`);
    }

    const data = await res.json() as any;
    const market = data.market_data;
    if (!market) return `No market data for "${coin}".`;

    const price = market.current_price?.usd;
    if (price == null) return `No price data available for "${coin}".`;
    const change24h = market.price_change_percentage_24h;
    const change7d = market.price_change_percentage_7d;
    const marketCap = market.market_cap?.usd;
    const volume24h = market.total_volume?.usd;
    const high24h = market.high_24h?.usd;
    const low24h = market.low_24h?.usd;
    const ath = market.ath?.usd;
    const athChange = market.ath_change_percentage?.usd;
    const rank = data.market_cap_rank;

    const lines = [
      `${data.name} (${data.symbol.toUpperCase()})${rank ? ` — Rank #${rank}` : ""}`,
      `Price: ${formatPrice(price)}`,
    ];

    if (change24h != null) {
      const arrow24 = change24h >= 0 ? "▲" : "▼";
      const sign24 = change24h >= 0 ? "+" : "";
      lines.push(`24h Change: ${sign24}${change24h.toFixed(2)}% ${arrow24}`);
    }

    if (change7d != null) {
      const sign7 = change7d >= 0 ? "+" : "";
      lines.push(`7d Change: ${sign7}${change7d.toFixed(2)}%`);
    }
    if (high24h != null && low24h != null) lines.push(`24h Range: ${formatPrice(low24h)} – ${formatPrice(high24h)}`);
    if (marketCap) lines.push(`Market Cap: ${formatNum(marketCap)}`);
    if (volume24h) lines.push(`24h Volume: ${formatNum(volume24h)}`);
    if (ath != null && athChange != null) lines.push(`ATH: ${formatPrice(ath)} (${athChange.toFixed(1)}% from ATH)`);

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Crypto price error:", msg);
    return `Unable to get crypto price for "${coin}": ${msg}`;
  }
}
