import { getPool } from "./db.js";
import * as polymarket from "./polymarket.js";

export interface PolymarketThesis {
  id: string;
  asset: string;
  asset_class: "polymarket";
  market_id: string;
  market_slug: string;
  direction: "YES" | "NO";
  confidence: "HIGH" | "MEDIUM" | "LOW" | "SPECULATIVE";
  current_odds: number;
  entry_odds: number;
  exit_odds: number;
  whale_consensus: number;
  whale_wallets: string[];
  whale_avg_score: number;
  total_whale_amount: number;
  volume: number;
  liquidity: number;
  end_date: string;
  category: string;
  sources: string[];
  reasoning: string;
  created_at: number;
  expires_at: number;
  status: "active" | "executed" | "expired" | "retired" | "invalidated";
  blacklist_until?: number;
}

const PM_THESIS_EXPIRY_MS = 72 * 60 * 60 * 1000;

let lastDiscoveryNotification: { hash: string; timestamp: number } = { hash: "", timestamp: 0 };
const DISCOVERY_DEDUP_MS = 120_000;

export function shouldSuppressDiscoveryNotification(walletAddresses: string[]): boolean {
  const hash = walletAddresses.map(a => a.toLowerCase()).sort().join(",");
  if (hash === lastDiscoveryNotification.hash && Date.now() - lastDiscoveryNotification.timestamp < DISCOVERY_DEDUP_MS) {
    return true;
  }
  return false;
}

export function markDiscoveryNotificationSent(walletAddresses: string[]): void {
  lastDiscoveryNotification = { hash: walletAddresses.map(a => a.toLowerCase()).sort().join(","), timestamp: Date.now() };
}

export function createPMThesisId(marketSlug: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
  const rand = Math.random().toString(36).slice(2, 8);
  const slug = marketSlug.replace(/[^a-z0-9]/gi, "_").slice(0, 20);
  return `pm_${date}_${slug}_${rand}`;
}

export async function getAllThesesRaw(): Promise<PolymarketThesis[]> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      return res.rows[0].value;
    }
  } catch (err) {
    console.error("[polymarket-scout] getAllThesesRaw error:", err);
  }
  return [];
}

export async function getActiveTheses(): Promise<PolymarketThesis[]> {
  const now = Date.now();
  const all = await getAllThesesRaw();
  return all.filter((t: PolymarketThesis) =>
    t.status === "active" &&
    t.expires_at > now &&
    (!t.blacklist_until || t.blacklist_until <= now)
  );
}

export async function saveTheses(theses: PolymarketThesis[]): Promise<void> {
  const pool = getPool();
  const allRaw = await getAllThesesRaw();
  const now = Date.now();

  const nonActive = allRaw.filter(t => t.status !== "active" || t.expires_at <= now || (t.blacklist_until && t.blacklist_until > now));
  const activeExisting = allRaw.filter(t => t.status === "active" && t.expires_at > now && (!t.blacklist_until || t.blacklist_until <= now));
  const newMarketIds = new Set(theses.map(t => t.market_id));
  const kept = activeExisting.filter(t => !newMarketIds.has(t.market_id));
  const merged = [...nonActive, ...kept, ...theses];

  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('polymarket_scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(merged), Date.now()]
  );
}

export async function retireThesis(thesisId: string): Promise<void> {
  const pool = getPool();
  const theses = await getAllThesesRaw();
  const updated = theses.map(t => t.id === thesisId ? { ...t, status: "retired" as const } : t);
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('polymarket_scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(updated), Date.now()]
  );
}

export async function invalidateThesis(thesisId: string, blacklistMs: number): Promise<PolymarketThesis | null> {
  const pool = getPool();
  const allTheses = await getAllThesesRaw();
  const target = allTheses.find(t => t.id === thesisId);
  if (!target) return null;

  const updated = allTheses.map(t => {
    if (t.id === thesisId) {
      return { ...t, status: "invalidated" as const, blacklist_until: Date.now() + blacklistMs };
    }
    if (t.market_id === target.market_id && t.status === "active") {
      return { ...t, status: "invalidated" as const, blacklist_until: Date.now() + blacklistMs };
    }
    return t;
  });

  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('polymarket_scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(updated), Date.now()]
  );

  return target;
}

export async function clearThesisBlacklist(thesisId: string): Promise<boolean> {
  const pool = getPool();
  const allTheses = await getAllThesesRaw();
  const target = allTheses.find(t => t.id === thesisId);
  if (!target) return false;

  const updated = allTheses.map(t => {
    if (t.id === thesisId && t.status === "invalidated") {
      return { ...t, status: "active" as const, blacklist_until: undefined };
    }
    return t;
  });

  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('polymarket_scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(updated), Date.now()]
  );

  return true;
}

export async function getBlacklistedTheses(): Promise<PolymarketThesis[]> {
  const now = Date.now();
  const all = await getAllThesesRaw();
  return all.filter(t => t.status === "invalidated" && t.blacklist_until && t.blacklist_until > now);
}

export function buildThesis(params: {
  market: polymarket.PolymarketMarket;
  direction: "YES" | "NO";
  confidence: "HIGH" | "MEDIUM" | "LOW" | "SPECULATIVE";
  whale_consensus: number;
  whale_wallets: string[];
  whale_avg_score: number;
  total_whale_amount: number;
  sources: string[];
  reasoning: string;
}): PolymarketThesis {
  const now = Date.now();
  const market = params.market;

  const yesPrice = market.tokens.find(t => t.outcome === "Yes")?.price || 0;
  const noPrice = market.tokens.find(t => t.outcome === "No")?.price || 0;
  const currentOdds = params.direction === "YES" ? yesPrice : noPrice;

  const entryOdds = currentOdds;
  const exitOdds = params.direction === "YES"
    ? Math.min(currentOdds + 0.15, 0.95)
    : Math.max(currentOdds - 0.15, 0.05);

  return {
    id: createPMThesisId(market.market_slug),
    asset: market.question,
    asset_class: "polymarket",
    market_id: market.condition_id,
    market_slug: market.market_slug,
    direction: params.direction,
    confidence: params.confidence,
    current_odds: parseFloat(currentOdds.toFixed(3)),
    entry_odds: parseFloat(entryOdds.toFixed(3)),
    exit_odds: parseFloat(exitOdds.toFixed(3)),
    whale_consensus: params.whale_consensus,
    whale_wallets: params.whale_wallets,
    whale_avg_score: params.whale_avg_score,
    total_whale_amount: params.total_whale_amount,
    volume: market.volume,
    liquidity: market.liquidity,
    end_date: market.end_date_iso,
    category: market.category,
    sources: params.sources,
    reasoning: params.reasoning,
    created_at: now,
    expires_at: now + PM_THESIS_EXPIRY_MS,
    status: "active",
  };
}

export function formatThesis(t: PolymarketThesis): string {
  const conf = { HIGH: "🟢", MEDIUM: "🟡", LOW: "🔴" }[t.confidence] || "⚪";
  const dir = t.direction === "YES" ? "✅ YES" : "❌ NO";
  const age = Math.round((Date.now() - t.created_at) / (60 * 60 * 1000));
  const expiry = Math.round((t.expires_at - Date.now()) / (60 * 60 * 1000));

  const lines = [
    `${conf} *${t.asset.slice(0, 80)}*`,
    `   Direction: ${dir} | Odds: ${(t.current_odds * 100).toFixed(0)}%`,
    `   Confidence: ${t.confidence} | Whales: ${t.whale_consensus} wallets`,
    `   Avg Score: ${t.whale_avg_score.toFixed(2)} | Amount: $${t.total_whale_amount.toFixed(0)}`,
    `   Volume: $${(t.volume / 1000).toFixed(0)}K | Category: ${t.category}`,
    `   Age: ${age}h | Expires: ${expiry}h | ID: \`${t.id}\``,
  ];

  return lines.join("\n");
}

export type ThesisTier = "HIGH" | "MEDIUM" | "LOW" | "SPECULATIVE";

export interface ThresholdResult {
  meets: boolean;
  tier: ThesisTier | null;
  failures: string[];
  passed: string[];
}

export async function migrateWalletRegistries(): Promise<void> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'copy_trading_wallets'`);
    if (res.rows.length === 0 || !Array.isArray(res.rows[0].value) || res.rows[0].value.length === 0) return;

    const oldWallets = res.rows[0].value;
    const current = await polymarket.getWhaleWatchlist();
    const existingAddresses = new Set(current.map(w => w.address.toLowerCase()));
    let migrated = 0;

    for (const old of oldWallets) {
      const addr = (old.address || '').toLowerCase();
      if (!addr || existingAddresses.has(addr)) continue;

      const wallet: polymarket.WhaleWallet = {
        address: addr,
        alias: old.alias || `Whale-${addr.slice(2, 8)}`,
        niche: old.niche || 'general',
        win_rate: old.win_rate || 0,
        roi: old.roi || 0,
        total_volume: old.total_volume || 0,
        total_trades: old.total_trades || 0,
        total_markets: old.total_markets || 0,
        resolved_markets: old.resolved_markets || 0,
        category_scores: old.category_scores || {},
        composite_score: old.composite_score || 0,
        last_active: old.last_active || Date.now(),
        last_checked: old.last_checked || 0,
        added_at: old.added_at || old.added_date || Date.now(),
        source: 'migration',
        enabled: old.enabled ?? true,
        observation_only: false,
        degraded_count: 0,
        pending_eviction: false,
        status: old.status || 'active',
      };
      wallet.composite_score = polymarket.scoreWallet(wallet);
      current.push(wallet);
      existingAddresses.add(addr);
      migrated++;
    }

    if (migrated > 0) {
      await polymarket.saveWhaleWatchlist(current);
      console.log(`[scout] Migrated ${migrated} wallets from copy_trading_wallets → polymarket_whale_watchlist`);
    }
  } catch (err) {
    console.error("[scout] migrateWalletRegistries error:", err instanceof Error ? err.message : err);
  }
}

export async function detectAndBlacklistMarketMakers(): Promise<string[]> {
  const watchlist = await polymarket.getWhaleWatchlist();
  const blacklisted: string[] = [];

  for (const wallet of watchlist) {
    let mmScore = 0;

    if (wallet.total_trades > 100) mmScore++;

    const positions = await polymarket.fetchWalletPositionsDirect(wallet.address);
    const buyCount = positions.filter((p: any) => parseFloat(p.size || '0') > 0).length;
    const sellCount = positions.filter((p: any) => parseFloat(p.size || '0') < 0).length;
    const total = buyCount + sellCount;
    if (total > 0) {
      const symmetry = Math.min(buyCount, sellCount) / Math.max(buyCount, sellCount);
      if (symmetry < 0.15) mmScore++;
    }

    if (wallet.total_markets > 20) mmScore++;

    const avgTradeSize = wallet.total_volume > 0 && wallet.total_trades > 0
      ? wallet.total_volume / wallet.total_trades
      : 0;
    if (avgTradeSize < 500 && avgTradeSize > 0) mmScore++;

    if (mmScore >= 3) {
      wallet.enabled = false;
      wallet.status = 'blacklisted';
      const bl = await polymarket.getBlacklist();
      if (!bl.includes(wallet.address.toLowerCase())) {
        bl.push(wallet.address.toLowerCase());
        await polymarket.saveBlacklist(bl);
      }
      blacklisted.push(`${wallet.alias} (${wallet.address.slice(0, 10)}) — MM score ${mmScore}/4`);
      console.log(`[scout] Blacklisted MM: ${wallet.alias} (score ${mmScore}/4)`);
    }
  }

  if (blacklisted.length > 0) {
    await polymarket.saveWhaleWatchlist(watchlist);
  }
  return blacklisted;
}

export interface WalletProfile {
  strategy: "sports" | "politics" | "crypto" | "weather" | "general" | "scraper" | "market-maker";
  copyEnabled: boolean;
  maxCopyPrice: number;
  minTradeSize: number;
  dominantCategory: string;
  avgEntryPrice: number;
  highPriceRatio: number;
  reasoning: string;
}

const MAX_COPY_PRICE_BY_NICHE: Record<string, number> = {
  sports:   0.80,
  politics: 0.92,
  crypto:   0.75,
  weather:  0.85,
  general:  0.85,
};

export async function decodeWallet(address: string): Promise<WalletProfile> {
  const activities = await polymarket.fetchWalletActivity(address, 50);

  if (!activities || activities.length < 5) {
    return {
      strategy: "general",
      copyEnabled: true,
      maxCopyPrice: 0.85,
      minTradeSize: 25,
      dominantCategory: "general",
      avgEntryPrice: 0,
      highPriceRatio: 0,
      reasoning: "Insufficient trade history — default thresholds applied",
    };
  }

  const buyTrades = activities.filter((t: any) => t.type === "TRADE" && t.side === "BUY");

  const categoryScores: Record<string, number> = {};
  for (const t of buyTrades) {
    const cat = polymarket.categorizeMarketTitle(t.title || "");
    categoryScores[cat] = (categoryScores[cat] || 0) + 1;
  }
  const total = Object.values(categoryScores).reduce((s, v) => s + v, 0);
  const normalized: Record<string, number> = {};
  for (const [k, v] of Object.entries(categoryScores)) {
    normalized[k] = total > 0 ? v / total : 0;
  }
  const dominantCategory = polymarket.determineNiche(normalized);

  const avgEntryPrice = buyTrades.length > 0
    ? buyTrades.reduce((sum: number, t: any) => sum + (parseFloat(t.price) || 0), 0) / buyTrades.length
    : 0;

  const highPriceTrades = buyTrades.filter((t: any) => (parseFloat(t.price) || 0) > 0.90).length;
  const highPriceRatio = buyTrades.length > 0 ? highPriceTrades / buyTrades.length : 0;
  const isScraper = avgEntryPrice > 0.90 && highPriceRatio > 0.50;

  const byMarket: Record<string, Set<string>> = {};
  for (const t of activities) {
    const cid = t.conditionId || t.market;
    if (!cid || t.type !== "TRADE") continue;
    if (!byMarket[cid]) byMarket[cid] = new Set();
    if (t.side) byMarket[cid].add(t.side);
  }
  const bothSidesCount = Object.values(byMarket).filter(s => s.has("BUY") && s.has("SELL")).length;
  const uniqueMarkets = Object.keys(byMarket).length;

  let mmScore = 0;
  if (uniqueMarkets > 0 && (bothSidesCount / uniqueMarkets) > 0.30) mmScore++;
  if (activities.length >= 50) mmScore++;
  if (uniqueMarkets > 20) mmScore++;
  const tradeSizes = buyTrades.map((t: any) => parseFloat(t.size || "0") * parseFloat(t.price || "0")).filter((v: number) => v > 0);
  const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a: number, b: number) => a + b, 0) / tradeSizes.length : 0;
  if (avgTradeSize < 500 && avgTradeSize > 0) mmScore++;
  const isMarketMaker = mmScore >= 3;

  const sortedSizes = tradeSizes.sort((a: number, b: number) => a - b);
  const medianSize = sortedSizes.length > 0 ? sortedSizes[Math.floor(sortedSizes.length / 2)] : 50;
  const minTradeSize = Math.max(medianSize * 0.3, 25);

  const strategy: WalletProfile["strategy"] = isScraper
    ? "scraper"
    : isMarketMaker
    ? "market-maker"
    : (dominantCategory as WalletProfile["strategy"]);

  const copyEnabled = !isScraper && !isMarketMaker;

  const reasoning = isScraper
    ? `Scraper detected — avg entry $${avgEntryPrice.toFixed(3)}, ${(highPriceRatio * 100).toFixed(0)}% of buys above $0.90`
    : isMarketMaker
    ? `Market maker detected — MM score ${mmScore}/4, both sides on ${bothSidesCount}/${uniqueMarkets} markets`
    : `${dominantCategory} specialist — avg entry $${avgEntryPrice.toFixed(3)}, ${buyTrades.length} buy trades analyzed`;

  return {
    strategy,
    copyEnabled,
    maxCopyPrice: copyEnabled ? (MAX_COPY_PRICE_BY_NICHE[dominantCategory] || 0.85) : 0,
    minTradeSize,
    dominantCategory,
    avgEntryPrice,
    highPriceRatio,
    reasoning,
  };
}

export async function scoreAndPromoteCandidate(address: string, source: "trade_mining" | "anomaly" = "trade_mining"): Promise<{
  added: boolean;
  wallet?: polymarket.WhaleWallet;
  reason?: string;
}> {
  const bl = await polymarket.getBlacklist();
  if (bl.includes(address.toLowerCase())) {
    return { added: false, reason: "blacklisted" };
  }

  const watchlist = await polymarket.getWhaleWatchlist();
  if (watchlist.some(w => w.address.toLowerCase() === address.toLowerCase())) {
    return { added: false, reason: "already_tracked" };
  }

  try {
    const wallet = await polymarket.buildWalletFromActivity(address, source);

    if (wallet.composite_score < 0.6) {
      return { added: false, wallet, reason: `score_${wallet.composite_score.toFixed(2)}_below_0.6` };
    }
    if (wallet.resolved_markets < 3) {
      return { added: false, wallet, reason: `only_${wallet.resolved_markets}_resolved_markets` };
    }

    const profile = await decodeWallet(address);
    if (!profile.copyEnabled) {
      console.log(`[scout] Decode rejected ${wallet.alias}: ${profile.reasoning}`);
      if (profile.strategy === "market-maker" || profile.strategy === "scraper") {
        const bl = await polymarket.getBlacklist();
        if (!bl.includes(address.toLowerCase())) {
          bl.push(address.toLowerCase());
          await polymarket.saveBlacklist(bl);
        }
      }
      try {
        const { sendMessage } = await import("./telegram.js");
        await sendMessage(`⛔ Wallet decode rejected <b>${wallet.alias}</b> (${address.slice(0, 10)}…)\n\nStrategy: ${profile.strategy}\n${profile.reasoning}`, "HTML");
      } catch {}
      return { added: false, wallet, reason: `decode_rejected: ${profile.reasoning}` };
    }

    wallet.strategy = profile.strategy;
    wallet.maxCopyPrice = profile.maxCopyPrice;
    wallet.minTradeSize = profile.minTradeSize;
    wallet.decodeReasoning = profile.reasoning;
    wallet.decodedAt = Date.now();
    wallet.niche = profile.dominantCategory;

    watchlist.push(wallet);
    await polymarket.saveWhaleWatchlist(watchlist);
    console.log(`[scout] Added ${wallet.alias} (score: ${wallet.composite_score.toFixed(2)}, niche: ${wallet.niche}, strategy: ${profile.strategy}, maxCopy: $${profile.maxCopyPrice}, source: ${source})`);

    try {
      const { sendMessage } = await import("./telegram.js");
      await sendMessage(`✅ Wallet admitted: <b>${wallet.alias}</b>\n\nStrategy: ${profile.strategy}\nMax copy price: $${profile.maxCopyPrice}\nMin trade size: $${profile.minTradeSize.toFixed(0)}\n${profile.reasoning}`, "HTML");
    } catch {}

    return { added: true, wallet };
  } catch (err) {
    return { added: false, reason: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function seedWalletsFromTradeStream(): Promise<{
  candidates_found: number;
  added: number;
  rejected: number;
  details: string[];
}> {
  const details: string[] = [];
  let added = 0, rejected = 0;

  try {
    const trades = await polymarket.fetchRecentTrades({ limit: 500, hoursBack: 2 });
    if (trades.length === 0) {
      details.push("No trades found in recent feed");
      return { candidates_found: 0, added: 0, rejected: 0, details };
    }

    const walletStats: Record<string, { volume: number; trades: number; markets: Set<string> }> = {};
    for (const trade of trades) {
      const addr = (trade.proxyWallet || '').toLowerCase();
      if (!addr) continue;
      if (!walletStats[addr]) walletStats[addr] = { volume: 0, trades: 0, markets: new Set() };
      walletStats[addr].volume += parseFloat(trade.size || '0') * parseFloat(trade.price || '0');
      walletStats[addr].trades++;
      if (trade.market) walletStats[addr].markets.add(trade.market);
    }

    const candidates = Object.entries(walletStats)
      .filter(([_, s]) => s.volume >= 1000 && s.trades >= 3)
      .sort((a, b) => b[1].volume - a[1].volume)
      .slice(0, 20);

    details.push(`Found ${candidates.length} high-volume candidates from ${trades.length} trades`);

    for (const [addr, stats] of candidates) {
      const result = await scoreAndPromoteCandidate(addr, "trade_mining");
      if (result.added) {
        added++;
        details.push(`✅ Added ${result.wallet!.alias} — score: ${result.wallet!.composite_score.toFixed(2)}, niche: ${result.wallet!.niche}`);
      } else {
        rejected++;
        details.push(`❌ Rejected ${addr.slice(0, 10)}: ${result.reason}`);
      }

      await new Promise(r => setTimeout(r, 500));

      const watchlist = await polymarket.getWhaleWatchlist();
      if (watchlist.length >= 10) {
        details.push(`Registry full (${watchlist.length}/10). Stopping seed.`);
        break;
      }
    }
  } catch (err) {
    details.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { candidates_found: added + rejected, added, rejected, details };
}

export async function runAnomalyScanner(): Promise<{
  trades_scanned: number;
  anomalies_found: number;
  wallets_added: number;
  details: string[];
}> {
  const details: string[] = [];
  let anomaliesFound = 0, walletsAdded = 0;

  try {
    const trades = await polymarket.fetchRecentTrades({ limit: 500, hoursBack: 0.5 });
    if (trades.length === 0) {
      return { trades_scanned: 0, anomalies_found: 0, wallets_added: 0, details: ["No recent trades"] };
    }

    const watchlist = await polymarket.getWhaleWatchlist();
    const trackedAddresses = new Set(watchlist.map(w => w.address.toLowerCase()));

    const unknownLarge: Record<string, { totalVolume: number; trades: any[]; markets: Set<string> }> = {};
    for (const trade of trades) {
      const addr = (trade.proxyWallet || '').toLowerCase();
      if (!addr || trackedAddresses.has(addr)) continue;
      const vol = parseFloat(trade.size || '0') * parseFloat(trade.price || '0');
      if (vol < 500) continue;

      if (!unknownLarge[addr]) unknownLarge[addr] = { totalVolume: 0, trades: [], markets: new Set() };
      unknownLarge[addr].totalVolume += vol;
      unknownLarge[addr].trades.push(trade);
      if (trade.market) unknownLarge[addr].markets.add(trade.market);
    }

    const anomalies = Object.entries(unknownLarge)
      .filter(([_, d]) => d.totalVolume >= 2000)
      .sort((a, b) => b[1].totalVolume - a[1].totalVolume)
      .slice(0, 5);

    anomaliesFound = anomalies.length;
    if (anomaliesFound === 0) {
      return { trades_scanned: trades.length, anomalies_found: 0, wallets_added: 0, details: ["No anomalies detected"] };
    }

    for (const [addr, data] of anomalies) {
      details.push(`🔍 Anomaly: ${addr.slice(0, 10)} — $${data.totalVolume.toFixed(0)} across ${data.markets.size} market(s)`);

      const result = await scoreAndPromoteCandidate(addr, "anomaly");
      if (result.added) {
        walletsAdded++;
        details.push(`  → Added as ${result.wallet!.alias} (observation_only, score: ${result.wallet!.composite_score.toFixed(2)})`);
      } else {
        details.push(`  → Rejected: ${result.reason}`);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    if (walletsAdded > 0) {
      const addedAddresses = anomalies.filter(([addr]) => details.some(d => d.includes("Added") && d.includes(addr.slice(0, 10)))).map(([addr]) => addr);

      if (!shouldSuppressDiscoveryNotification(addedAddresses)) {
        try {
          const { sendMessage } = await import("./telegram.js");
          const fmt = await import("./telegram-format.js");
          const anomalyLines = [
            fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.DISCOVERY, "New Whale Candidate"),
            "",
            ...details.map(d => fmt.escapeHtml(d)),
          ];
          sendMessage(fmt.truncateToTelegramLimit(anomalyLines.join("\n")), "HTML").catch(() => {});
        } catch {}
        markDiscoveryNotificationSent(addedAddresses);
      } else {
        console.log(`[anomaly-scanner] Suppressed duplicate DISCOVERY notification (${addedAddresses.length} wallets, last sent ${Math.round((Date.now() - lastDiscoveryNotification.timestamp) / 1000)}s ago)`);
      }
    }
  } catch (err) {
    details.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { trades_scanned: 500, anomalies_found: anomaliesFound, wallets_added: walletsAdded, details };
}

export async function meetsThesisThresholds(params: {
  whale_score: number;
  whale_consensus: number;
  market_volume: number;
  market_liquidity: number;
  odds: number;
  hours_to_resolution: number;
}): Promise<ThresholdResult> {
  const failures: string[] = [];
  const passed: string[] = [];

  const oddsInRange = params.odds >= 0.15 && params.odds <= 0.85;
  const oddsInTightRange = params.odds >= 0.30 && params.odds <= 0.70;
  const volumeAbove50K = params.market_volume >= 50000;
  const volumeAbove100K = params.market_volume >= 100000;
  const volumeAbove500K = params.market_volume >= 500000;
  const minResolution = volumeAbove100K ? 12 : 24;
  const resolutionOk = params.hours_to_resolution >= minResolution;

  if (!oddsInRange) failures.push(`Odds ${(params.odds * 100).toFixed(0)}% outside 15-85% range`);
  else passed.push(`Odds ${(params.odds * 100).toFixed(0)}% in range`);

  if (!resolutionOk) failures.push(`Resolution in ${params.hours_to_resolution.toFixed(0)}h < ${minResolution}h minimum`);
  else passed.push(`Resolution ${params.hours_to_resolution.toFixed(0)}h >= ${minResolution}h`);

  if (!volumeAbove50K) failures.push(`Volume $${params.market_volume.toFixed(0)} < $50,000`);
  else passed.push(`Volume $${params.market_volume.toFixed(0)}`);

  if (!oddsInRange || !resolutionOk || !volumeAbove50K) {
    console.log(`[pm-scout] Threshold REJECT: ${failures.join("; ")}`);
    return { meets: false, tier: null, failures, passed };
  }

  if (params.whale_consensus >= 3 && params.whale_score >= 0.8) {
    passed.push(`Strong whale consensus: ${params.whale_consensus} whales, score ${params.whale_score.toFixed(2)}`);
    console.log(`[pm-scout] Threshold PASS (HIGH): ${passed.join("; ")}`);
    return { meets: true, tier: "HIGH", failures: [], passed };
  }

  if (params.whale_consensus >= 2 && params.whale_score >= 0.5) {
    passed.push(`Whale consensus: ${params.whale_consensus} whales, score ${params.whale_score.toFixed(2)}`);
    console.log(`[pm-scout] Threshold PASS (MEDIUM): ${passed.join("; ")}`);
    return { meets: true, tier: "MEDIUM", failures: [], passed };
  }

  if (params.whale_consensus >= 1 && params.whale_score >= 0.7) {
    passed.push(`Single whale signal: score ${params.whale_score.toFixed(2)}`);
    console.log(`[pm-scout] Threshold PASS (SPECULATIVE): ${passed.join("; ")}`);
    return { meets: true, tier: "SPECULATIVE", failures: [], passed };
  }

  if (volumeAbove500K && oddsInTightRange && params.whale_consensus === 0) {
    passed.push(`Volume-weighted fallback: $${(params.market_volume / 1000).toFixed(0)}K volume, ${(params.odds * 100).toFixed(0)}% odds (high uncertainty edge)`);
    console.log(`[pm-scout] Threshold PASS (LOW): ${passed.join("; ")}`);
    return { meets: true, tier: "LOW", failures: [], passed };
  }

  failures.push(`Whale consensus ${params.whale_consensus} whales, score ${params.whale_score.toFixed(2)} — insufficient for any tier`);
  if (!volumeAbove500K && params.whale_consensus === 0) {
    failures.push(`Volume $${params.market_volume.toFixed(0)} < $500K for volume-only fallback`);
  }
  if (!oddsInTightRange && params.whale_consensus === 0) {
    failures.push(`Odds ${(params.odds * 100).toFixed(0)}% outside 30-70% for volume-only fallback`);
  }
  console.log(`[pm-scout] Threshold REJECT: ${failures.join("; ")}`);
  return { meets: false, tier: null, failures, passed };
}
