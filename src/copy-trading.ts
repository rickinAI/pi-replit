import { getPool } from "./db.js";
import * as polymarket from "./polymarket.js";
import * as bankr from "./bankr.js";

export async function getTrackedWallets(): Promise<polymarket.WhaleWallet[]> {
  return polymarket.getWhaleWatchlist();
}

export async function addWallet(data: any): Promise<polymarket.WhaleWallet> {
  const wallets = await polymarket.getWhaleWatchlist();
  const wallet = await polymarket.buildWalletFromActivity(
    data.address,
    data.source || 'manual'
  );
  if (data.alias) wallet.alias = data.alias;

  const { decodeWallet } = await import("./polymarket-scout.js");
  const profile = await decodeWallet(data.address);
  if (!profile.copyEnabled) {
    const bl = await polymarket.getBlacklist();
    if (!bl.includes(data.address.toLowerCase())) {
      bl.push(data.address.toLowerCase());
      await polymarket.saveBlacklist(bl);
    }
    throw new Error(`Wallet rejected by decode: ${profile.reasoning}`);
  }
  wallet.strategy = profile.strategy;
  wallet.maxCopyPrice = profile.maxCopyPrice;
  wallet.minTradeSize = profile.minTradeSize;
  wallet.decodeReasoning = profile.reasoning;
  wallet.decodedAt = Date.now();
  wallet.niche = profile.dominantCategory;

  wallets.push(wallet);
  await polymarket.saveWhaleWatchlist(wallets);
  return wallet;
}

export async function removeWallet(address: string): Promise<boolean> {
  const wallets = await polymarket.getWhaleWatchlist();
  const idx = wallets.findIndex(w => w.address.toLowerCase() === address.toLowerCase());
  if (idx === -1) return false;
  wallets.splice(idx, 1);
  await polymarket.saveWhaleWatchlist(wallets);
  return true;
}

export interface PositionSnapshot {
  wallet_address: string;
  market_id: string;
  market_question: string;
  direction: "YES" | "NO";
  amount_usd: number;
  odds: number;
  detected_at: number;
}

export interface WalletSnapshot {
  wallet_address: string;
  positions: PositionSnapshot[];
  taken_at: number;
}

export interface CopyTradeSignal {
  wallet_address: string;
  wallet_alias: string;
  wallet_win_rate: number;
  market_id: string;
  market_question: string;
  market_slug: string;
  direction: "YES" | "NO";
  odds: number;
  volume: number;
  liquidity: number;
  end_date: string;
  amount_usd: number;
  signal_type: "new_entry" | "exit";
  detected_at: number;
}

export interface WalletPerformance {
  wallet_address: string;
  wallet_alias: string;
  total_copy_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
  last_trade_at: number;
}

export interface SignalResult {
  execute: boolean;
  score: number;
  maxScore: number;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  positionSize: number;
  signals: string[];
  reason?: string;
}

const SNAPSHOTS_KEY = "copy_trading_snapshots";
const COPY_TRADE_SIGNALS_KEY = "copy_trading_signals";
const COPY_TRADE_DRAWDOWN_KEY = "copy_trading_drawdown";

const COPY_TRADE_SIZE_USD = 50;
const COPY_TRADE_SIZE_HALF = 25;
const MAX_CONCURRENT_COPY_TRADES = 3;
const PORTFOLIO_HARD_STOP_DRAWDOWN = 100;
const MIN_ODDS = 0.15;
const MAX_ODDS = 0.85;
const MIN_HOURS_TO_RESOLUTION = 24;
const MIN_VOLUME = 10000;
const MIN_LIQUIDITY = 10000;
const MIN_WALLET_WIN_RATE = 65;

async function getSnapshots(): Promise<WalletSnapshot[]> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [SNAPSHOTS_KEY]);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      return res.rows[0].value;
    }
  } catch {}
  return [];
}

async function saveSnapshots(snapshots: WalletSnapshot[]): Promise<void> {
  const pool = getPool();
  const maxSnapshots = 50;
  const trimmed = snapshots.slice(-maxSnapshots);
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [SNAPSHOTS_KEY, JSON.stringify(trimmed), Date.now()]
  );
}

async function getCopyTradeDrawdown(): Promise<number> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [COPY_TRADE_DRAWDOWN_KEY]);
    if (res.rows.length > 0 && typeof res.rows[0].value === "number") {
      return res.rows[0].value;
    }
  } catch {}
  return 0;
}

export async function updateCopyTradeDrawdown(pnl: number): Promise<number> {
  const current = await getCopyTradeDrawdown();
  const updated = current + pnl;
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [COPY_TRADE_DRAWDOWN_KEY, JSON.stringify(updated), Date.now()]
  );
  return updated;
}

function mapDataApiPosition(raw: any, walletAddress: string): PositionSnapshot {
  return {
    wallet_address: walletAddress.toLowerCase(),
    market_id: raw.conditionId || '',
    market_question: raw.title || '',
    direction: raw.outcomeIndex === 0 ? 'YES' : 'NO',
    amount_usd: parseFloat(raw.size || '0') * parseFloat(raw.avgPrice || '0'),
    odds: parseFloat(raw.curPrice || '0'),
    detected_at: Date.now(),
  };
}

export async function fetchWalletPositions(walletAddress: string): Promise<PositionSnapshot[]> {
  try {
    const rawPositions = await polymarket.fetchWalletPositionsDirect(walletAddress);
    return rawPositions
      .filter((p: any) => parseFloat(p.size || '0') > 0)
      .map((p: any) => mapDataApiPosition(p, walletAddress));
  } catch (err) {
    console.error(`[copy-trading] fetchWalletPositions error for ${walletAddress.slice(0, 10)}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

export function diffSnapshots(
  previous: PositionSnapshot[],
  current: PositionSnapshot[],
  walletAddress: string,
  walletAlias: string,
  walletWinRate: number
): CopyTradeSignal[] {
  const signals: CopyTradeSignal[] = [];
  const prevMarkets = new Set(previous.map(p => `${p.market_id}_${p.direction}`));
  const currMarkets = new Set(current.map(p => `${p.market_id}_${p.direction}`));

  for (const pos of current) {
    const key = `${pos.market_id}_${pos.direction}`;
    if (!prevMarkets.has(key)) {
      signals.push({
        wallet_address: walletAddress,
        wallet_alias: walletAlias,
        wallet_win_rate: walletWinRate,
        market_id: pos.market_id,
        market_question: pos.market_question,
        market_slug: "",
        direction: pos.direction,
        odds: pos.odds,
        volume: 0,
        liquidity: 0,
        end_date: "",
        amount_usd: pos.amount_usd,
        signal_type: "new_entry",
        detected_at: Date.now(),
      });
    }
  }

  for (const pos of previous) {
    const key = `${pos.market_id}_${pos.direction}`;
    if (!currMarkets.has(key)) {
      signals.push({
        wallet_address: walletAddress,
        wallet_alias: walletAlias,
        wallet_win_rate: walletWinRate,
        market_id: pos.market_id,
        market_question: pos.market_question,
        market_slug: "",
        direction: pos.direction,
        odds: 0,
        volume: 0,
        liquidity: 0,
        end_date: "",
        amount_usd: pos.amount_usd,
        signal_type: "exit",
        detected_at: Date.now(),
      });
    }
  }

  return signals;
}

export async function runSignalEngine(
  wallet: polymarket.WhaleWallet,
  market: polymarket.PolymarketMarket,
  direction: "YES" | "NO",
  currentPrice: number
): Promise<SignalResult> {
  const signals: string[] = [];

  if (wallet.composite_score < 0.6) {
    return { execute: false, score: 0, maxScore: 13, confidence: "LOW", positionSize: 0, signals: ["Gate: wallet score below 0.6"], reason: "wallet_score_below_0.6" };
  }
  if (currentPrice < MIN_ODDS || currentPrice > MAX_ODDS) {
    return { execute: false, score: 0, maxScore: 13, confidence: "LOW", positionSize: 0, signals: [`Gate: odds ${(currentPrice * 100).toFixed(0)}% outside 15-85%`], reason: "odds_outside_range" };
  }
  const endDate = new Date(market.end_date_iso);
  const hoursToRes = (endDate.getTime() - Date.now()) / (60 * 60 * 1000);
  if (hoursToRes < MIN_HOURS_TO_RESOLUTION) {
    return { execute: false, score: 0, maxScore: 13, confidence: "LOW", positionSize: 0, signals: [`Gate: market expires in ${hoursToRes.toFixed(0)}h`], reason: "market_expires_soon" };
  }

  let score = 0;

  const vpin = await polymarket.calculateVPIN(market.condition_id);
  if (vpin >= 0.5) { score += 3; signals.push(`VPIN: ${vpin.toFixed(2)} (+3)`); }
  else if (vpin >= 0.2) { score += 1; signals.push(`VPIN: ${vpin.toFixed(2)} (+1)`); }
  else { signals.push(`VPIN: ${vpin.toFixed(2)} (thin)`); }

  const watchlist = await polymarket.getWhaleWatchlist();
  const snapshots = await getSnapshots();
  let consensusCount = 0;
  for (const w of watchlist) {
    if (w.address === wallet.address) { consensusCount++; continue; }
    const snap = snapshots.find(s => s.wallet_address === w.address);
    if (snap?.positions.some(p => p.market_id === market.condition_id && p.direction === direction)) {
      consensusCount++;
    }
  }
  if (consensusCount >= 3) { score += 3; signals.push(`Consensus: ${consensusCount} whales (+3)`); }
  else if (consensusCount === 2) { score += 2; signals.push(`Consensus: 2 whales (+2)`); }
  else { signals.push(`Consensus: 1 whale (+0)`); }

  const marketNiche = polymarket.categorizeMarketTitle(market.question);
  if (wallet.niche !== 'general' && wallet.niche === marketNiche) {
    score += 2; signals.push(`Niche match: ${wallet.niche} (+2)`);
  } else if (wallet.niche === 'general') {
    score += 1; signals.push(`Niche: general (+1)`);
  } else {
    signals.push(`Niche MISMATCH: wallet=${wallet.niche} market=${marketNiche} (+0)`);
  }

  const stats = await polymarket.getMarketPriceStats(market.condition_id);
  if (stats && stats.sigma > 0) {
    const z = (currentPrice - stats.mean) / stats.sigma;
    if (Math.abs(z) >= 2.5) {
      score += 2; signals.push(`Z-score: ${z.toFixed(1)} extreme (+2)`);
    } else {
      signals.push(`Z-score: ${z.toFixed(1)} normal (+0)`);
    }
  } else {
    signals.push(`Z-score: no data yet (+0)`);
  }

  if (marketNiche === 'weather') {
    const noaaEdge = await polymarket.checkNOAAEdge(market);
    if (noaaEdge !== null) {
      if (noaaEdge >= 0.30) { score += 3; signals.push(`NOAA: +${(noaaEdge * 100).toFixed(0)}pt gap (+3)`); }
      else if (noaaEdge >= 0.20) { score += 2; signals.push(`NOAA: +${(noaaEdge * 100).toFixed(0)}pt gap (+2)`); }
      else if (noaaEdge >= 0.10) { score += 1; signals.push(`NOAA: +${(noaaEdge * 100).toFixed(0)}pt gap (+1)`); }
      else { signals.push(`NOAA: +${(noaaEdge * 100).toFixed(0)}pt weak (+0)`); }
    }
  }

  let positionSize = 0;
  let confidence: "LOW" | "MEDIUM" | "HIGH" = "LOW";
  if (score >= 8) { positionSize = COPY_TRADE_SIZE_USD; confidence = "HIGH"; }
  else if (score >= 4) { positionSize = COPY_TRADE_SIZE_HALF; confidence = "MEDIUM"; }

  return {
    execute: positionSize > 0,
    score,
    maxScore: 13,
    confidence,
    positionSize,
    signals,
    reason: positionSize === 0 ? `signal_score_${score}/13_below_threshold` : undefined,
  };
}

export interface CopyTradeFilterResult {
  passed: boolean;
  failures: string[];
  signal: CopyTradeSignal;
}

export async function evaluateCopyTradeSignal(signal: CopyTradeSignal): Promise<CopyTradeFilterResult> {
  const failures: string[] = [];

  if (signal.wallet_win_rate < MIN_WALLET_WIN_RATE) {
    failures.push(`Wallet win rate ${signal.wallet_win_rate}% < ${MIN_WALLET_WIN_RATE}% minimum`);
  }

  const market = await polymarket.getMarketDetails(signal.market_id);
  if (!market) {
    failures.push(`Could not fetch market details for ${signal.market_id}`);
    return { passed: false, failures, signal };
  }

  signal.market_slug = market.market_slug;
  signal.volume = market.volume;
  signal.liquidity = market.liquidity;
  signal.end_date = market.end_date_iso;

  const yesPrice = market.tokens.find(t => t.outcome === "Yes")?.price || 0;
  const noPrice = market.tokens.find(t => t.outcome === "No")?.price || 0;
  const currentOdds = signal.direction === "YES" ? yesPrice : noPrice;
  signal.odds = currentOdds;

  if (market.volume < MIN_VOLUME) {
    failures.push(`Volume $${market.volume.toFixed(0)} < $${MIN_VOLUME} minimum`);
  }

  if (market.liquidity < MIN_LIQUIDITY) {
    failures.push(`Liquidity $${market.liquidity.toFixed(0)} < $${MIN_LIQUIDITY} minimum`);
  }

  if (currentOdds < MIN_ODDS || currentOdds > MAX_ODDS) {
    failures.push(`Odds ${(currentOdds * 100).toFixed(0)}% outside ${MIN_ODDS * 100}-${MAX_ODDS * 100}% range`);
  }

  const endDate = new Date(market.end_date_iso);
  const hoursToResolution = (endDate.getTime() - Date.now()) / (60 * 60 * 1000);
  if (hoursToResolution < MIN_HOURS_TO_RESOLUTION) {
    failures.push(`Resolution in ${hoursToResolution.toFixed(0)}h < ${MIN_HOURS_TO_RESOLUTION}h minimum`);
  }

  if (market.closed) {
    failures.push("Market is already closed");
  }

  const positions = await bankr.getPositions();
  const copyPositions = positions.filter(p => p.is_copy_trade);
  if (copyPositions.length >= MAX_CONCURRENT_COPY_TRADES) {
    failures.push(`Max concurrent copy trades reached (${copyPositions.length}/${MAX_CONCURRENT_COPY_TRADES})`);
  }

  const alreadyCopied = positions.some(
    p => p.is_copy_trade && p.market_id === signal.market_id
  );
  if (alreadyCopied) {
    failures.push("Already have a copy trade on this market");
  }

  const drawdown = await getCopyTradeDrawdown();
  if (drawdown <= -PORTFOLIO_HARD_STOP_DRAWDOWN) {
    failures.push(`Copy trade drawdown $${Math.abs(drawdown).toFixed(0)} exceeds $${PORTFOLIO_HARD_STOP_DRAWDOWN} hard stop`);
  }

  return { passed: failures.length === 0, failures, signal };
}

export async function executeCopyTrade(signal: CopyTradeSignal, positionSize?: number): Promise<{
  success: boolean;
  position_id?: string;
  error?: string;
}> {
  const thesisId = `copy_${signal.wallet_address.slice(0, 8)}_${signal.market_id.slice(0, 12)}_${Date.now()}`;
  const size = positionSize || COPY_TRADE_SIZE_USD;

  try {
    const killActive = await bankr.isKillSwitchActive();
    if (killActive) return { success: false, error: "Kill switch active" };

    const paused = await bankr.isPaused();
    if (paused) return { success: false, error: "System paused" };

    const rc = await bankr.getRiskConfig();
    const portfolio = await bankr.getPortfolioValue();
    const peak = await bankr.getPeakPortfolioValue();
    const peakDrawdownPct = peak > 0 ? ((portfolio - peak) / peak) * 100 : 0;
    if (peakDrawdownPct < rc.circuit_breaker_drawdown_pct) {
      return { success: false, error: `Circuit breaker: drawdown ${peakDrawdownPct.toFixed(1)}% exceeds ${rc.circuit_breaker_drawdown_pct}% limit` };
    }

    const positions = await bankr.getPositions();
    if (positions.length >= rc.max_positions) {
      return { success: false, error: `Max positions reached (${positions.length}/${rc.max_positions})` };
    }

    const mode = await bankr.getMode();

    const result = await bankr.openPosition({
      thesis_id: thesisId,
      asset: signal.market_question.slice(0, 100),
      asset_class: "polymarket",
      source: "copy_trade",
      direction: signal.direction,
      leverage: 1,
      entry_price: signal.odds,
      stop_price: 0,
      atr_value: 0,
      venue: "bnkr",
      market_id: signal.market_id,
      is_copy_trade: true,
      source_wallet: signal.wallet_address,
      copy_trade_size_usd: size,
    });

    if (result.position) {
      console.log(`[copy-trading] Copy trade opened: ${signal.market_question.slice(0, 60)} ${signal.direction} $${size} from ${signal.wallet_alias} (mode: ${mode})`);
      return { success: true, position_id: result.position.id };
    }
    return { success: false, error: "Position returned null" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[copy-trading] executeCopyTrade error: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function handleWhaleExit(signal: CopyTradeSignal): Promise<{ closed: boolean; trade_id?: string }> {
  const positions = await bankr.getPositions();
  const matchingPos = positions.find(
    p => p.is_copy_trade
      && p.source_wallet === signal.wallet_address
      && p.market_id === signal.market_id
  );

  if (!matchingPos) return { closed: false };

  try {
    const market = await polymarket.getMarketDetails(signal.market_id);
    const yesPrice = market?.tokens.find(t => t.outcome === "Yes")?.price || matchingPos.current_price;
    const noPrice = market?.tokens.find(t => t.outcome === "No")?.price || matchingPos.current_price;
    const exitPrice = matchingPos.direction === "YES" ? yesPrice : noPrice;

    const record = await bankr.closePosition(matchingPos.id, exitPrice, "whale_exit_mirror");
    if (record) {
      await updateCopyTradeDrawdown(record.pnl);
      console.log(`[copy-trading] Whale exit mirror: ${matchingPos.asset.slice(0, 60)} P&L: $${record.pnl.toFixed(2)}`);
      return { closed: true, trade_id: record.id };
    }
  } catch (err) {
    console.error("[copy-trading] handleWhaleExit error:", err instanceof Error ? err.message : err);
  }
  return { closed: false };
}

export async function autoRedeemResolved(): Promise<{ redeemed: number; alerts: string[] }> {
  const positions = await bankr.getPositions();
  const copyPositions = positions.filter(p => p.is_copy_trade && p.market_id);
  let redeemed = 0;
  const alerts: string[] = [];

  for (const pos of copyPositions) {
    try {
      const posData = await polymarket.fetchWalletPositionsDirect(pos.source_wallet || '');
      const resolved = posData.find((p: any) =>
        p.conditionId === pos.market_id && p.redeemable === true
      );

      if (resolved) {
        const exitPrice = parseFloat(resolved.curPrice || '0');
        const record = await bankr.closePosition(pos.id, exitPrice, "market_resolved");
        if (record) {
          await updateCopyTradeDrawdown(record.pnl);
          redeemed++;
          const pnlStr = record.pnl >= 0 ? `+$${record.pnl.toFixed(2)}` : `-$${Math.abs(record.pnl).toFixed(2)}`;
          alerts.push(`Redeemed: ${pos.asset.slice(0, 60)} | P&L: ${pnlStr}`);
        }
      }
    } catch (err) {
      console.error(`[copy-trading] autoRedeemResolved error for ${pos.id}:`, err instanceof Error ? err.message : err);
    }
  }

  return { redeemed, alerts };
}

export async function runCopyTradeScan(): Promise<{
  wallets_checked: number;
  new_entries: CopyTradeSignal[];
  exits: CopyTradeSignal[];
  trades_opened: number;
  trades_closed: number;
  errors: string[];
  signal_results: { signal: CopyTradeSignal; result: SignalResult }[];
}> {
  const registry = await polymarket.getWhaleWatchlist();
  let modified = false;
  for (const w of registry) {
    if (w.observation_only && (Date.now() - w.added_at) > 5 * 60 * 1000) {
      w.observation_only = false;
      modified = true;
      console.log(`[copy-trade] Cleared observation for ${w.alias}`);
    }
  }
  if (modified) await polymarket.saveWhaleWatchlist(registry);

  const enabledWallets = registry.filter(w => w.enabled && w.status === 'active');
  const previousSnapshots = await getSnapshots();
  const newSnapshots: WalletSnapshot[] = [];
  const allSignals: CopyTradeSignal[] = [];
  const errors: string[] = [];
  let tradesOpened = 0;
  let tradesClosed = 0;
  const signalResults: { signal: CopyTradeSignal; result: SignalResult }[] = [];

  for (const wallet of enabledWallets) {
    try {
      const currentPositions = await fetchWalletPositions(wallet.address);

      await polymarket.updateMarketPriceStats(
        wallet.address,
        currentPositions.length > 0 ? currentPositions[0].odds : 0
      );

      for (const pos of currentPositions) {
        if (pos.market_id) {
          await polymarket.updateMarketPriceStats(pos.market_id, pos.odds);
        }
      }

      const prevSnapshot = previousSnapshots.find(
        s => s.wallet_address.toLowerCase() === wallet.address.toLowerCase()
      );
      const prevPositions = prevSnapshot?.positions || [];

      if (currentPositions.length === 0 && prevPositions.length > 0) {
        console.log(`[copy-trading] ${wallet.alias}: empty fetch with ${prevPositions.length} previous positions — skipping diff`);
        newSnapshots.push({
          wallet_address: wallet.address,
          positions: prevPositions,
          taken_at: Date.now(),
        });
        const updatedRegistry = await polymarket.getWhaleWatchlist();
        const w = updatedRegistry.find(r => r.address === wallet.address);
        if (w) { w.last_checked = Date.now(); await polymarket.saveWhaleWatchlist(updatedRegistry); }
        continue;
      }

      const signals = diffSnapshots(
        prevPositions,
        currentPositions,
        wallet.address,
        wallet.alias,
        wallet.win_rate * 100
      );

      allSignals.push(...signals);

      newSnapshots.push({
        wallet_address: wallet.address,
        positions: currentPositions,
        taken_at: Date.now(),
      });

      const updatedRegistry = await polymarket.getWhaleWatchlist();
      const w = updatedRegistry.find(r => r.address === wallet.address);
      if (w) { w.last_checked = Date.now(); await polymarket.saveWhaleWatchlist(updatedRegistry); }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${wallet.alias}: ${msg}`);
    }
  }

  await saveSnapshots(newSnapshots);

  const newEntries = allSignals.filter(s => s.signal_type === "new_entry");
  const exits = allSignals.filter(s => s.signal_type === "exit");

  for (const exit of exits) {
    const result = await handleWhaleExit(exit);
    if (result.closed) tradesClosed++;
  }

  const buyEntries = newEntries.filter(e => e.direction === "YES" || e.direction === "NO");
  for (const entry of buyEntries) {
    if (entry.signal_type !== "new_entry") continue;

    const wallet = registry.find(w => w.address === entry.wallet_address);
    if (!wallet) continue;

    if (wallet.observation_only) {
      console.log(`[copy-trading] ${wallet.alias}: observation_only — skipping trade on ${entry.market_question.slice(0, 40)}`);
      continue;
    }

    if (wallet.minTradeSize && entry.amount_usd < wallet.minTradeSize) {
      console.log(`[copy-trading] ${wallet.alias}: trade $${entry.amount_usd.toFixed(0)} below minTradeSize $${wallet.minTradeSize.toFixed(0)} — skipping`);
      continue;
    }

    const market = await polymarket.getMarketDetails(entry.market_id);
    if (!market) continue;

    const yesPrice = market.tokens.find(t => t.outcome === "Yes")?.price || 0;
    const noPrice = market.tokens.find(t => t.outcome === "No")?.price || 0;
    const currentPrice = entry.direction === "YES" ? yesPrice : noPrice;

    if (wallet.maxCopyPrice && currentPrice > wallet.maxCopyPrice) {
      console.log(`[copy-trading] ${wallet.alias}: price $${currentPrice.toFixed(3)} exceeds maxCopyPrice $${wallet.maxCopyPrice} — skipping ${entry.market_question.slice(0, 40)}`);
      continue;
    }

    const signalResult = await runSignalEngine(wallet, market, entry.direction, currentPrice);
    signalResults.push({ signal: entry, result: signalResult });

    if (!signalResult.execute) {
      console.log(`[copy-trading] Signal rejected (${signalResult.score}/${signalResult.maxScore}): ${entry.market_question.slice(0, 60)} — ${signalResult.reason}`);
      continue;
    }

    const evaluation = await evaluateCopyTradeSignal(entry);
    if (evaluation.passed) {
      const result = await executeCopyTrade(entry, signalResult.positionSize);
      if (result.success) {
        tradesOpened++;

        try {
          const { sendMessage } = await import("./telegram.js");
          const fmt = await import("./telegram-format.js");
          const nicheEmoji = fmt.getNicheEmoji(wallet.niche);
          const marketBadge = fmt.getMarketBadge(wallet.niche);
          const confBar = fmt.buildConfidenceBar(signalResult.confidence);
          const oneLiner = fmt.getOneLiner(signalResult.confidence);
          const addrShort = fmt.truncateAddress(wallet.address);
          const marketQ = fmt.escapeHtml(entry.market_question.slice(0, 80));
          const sizeLabel = signalResult.positionSize >= 50 ? "full size" : signalResult.positionSize >= 25 ? "half size" : "skip";

          const lines = [
            fmt.CATEGORY_BADGES.COPY_TRADE,
            "",
            `${marketBadge} · ${nicheEmoji} ${addrShort}`,
            "",
            marketQ,
            `Confidence: ${confBar}  ${signalResult.confidence}`,
            `Direction: ${entry.direction} · Entry: $${currentPrice.toFixed(2)}`,
            "",
            `💬 "${oneLiner}"`,
            "",
            `Whale score: ${wallet.composite_score.toFixed(1)} · Consensus: ${signalResult.signals.length} signals`,
            fmt.SEPARATOR,
            `Portfolio impact: $${signalResult.positionSize} (${sizeLabel})`,
          ];
          sendMessage(fmt.truncateToTelegramLimit(lines.join("\n")), "HTML").catch(() => {});
        } catch {}
      } else {
        errors.push(`Failed to copy ${entry.market_question.slice(0, 40)}: ${result.error}`);
      }
    } else {
      console.log(`[copy-trading] Evaluation rejected: ${entry.market_question.slice(0, 60)} — ${evaluation.failures.join("; ")}`);
    }
  }

  const redeemResult = await autoRedeemResolved();
  if (redeemResult.redeemed > 0) {
    try {
      const { sendMessage } = await import("./telegram.js");
      const fmt = await import("./telegram-format.js");
      for (const alert of redeemResult.alerts) {
        const lines = [
          fmt.CATEGORY_BADGES.AUTO_REDEEM,
          "",
          fmt.escapeHtml(alert),
        ];
        sendMessage(fmt.truncateToTelegramLimit(lines.join("\n")), "HTML").catch(() => {});
      }
    } catch {}
  }

  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [COPY_TRADE_SIGNALS_KEY, JSON.stringify(allSignals.slice(-100)), Date.now()]
    );
  } catch {}

  return {
    wallets_checked: enabledWallets.length,
    new_entries: newEntries,
    exits,
    trades_opened: tradesOpened,
    trades_closed: tradesClosed,
    errors,
    signal_results: signalResults,
  };
}

export async function getWalletPerformance(): Promise<WalletPerformance[]> {
  const wallets = await polymarket.getWhaleWatchlist();
  const history = await bankr.getTradeHistory();
  const copyTrades = history.filter(t => t.source === "copy_trade");

  return wallets.map(wallet => {
    const walletTrades = copyTrades.filter(
      t => t.source_wallet?.toLowerCase() === wallet.address.toLowerCase()
    );
    const wins = walletTrades.filter(t => t.pnl > 0).length;
    const losses = walletTrades.filter(t => t.pnl <= 0).length;
    const totalPnl = walletTrades.reduce((s, t) => s + t.pnl, 0);
    const lastTrade = walletTrades.length > 0
      ? Math.max(...walletTrades.map(t => new Date(t.closed_at).getTime()))
      : 0;

    return {
      wallet_address: wallet.address,
      wallet_alias: wallet.alias,
      total_copy_trades: walletTrades.length,
      wins,
      losses,
      win_rate: walletTrades.length > 0 ? parseFloat((wins / walletTrades.length * 100).toFixed(1)) : 0,
      total_pnl: parseFloat(totalPnl.toFixed(2)),
      avg_pnl: walletTrades.length > 0 ? parseFloat((totalPnl / walletTrades.length).toFixed(2)) : 0,
      last_trade_at: lastTrade,
    };
  });
}

export async function checkCopyTradeExits(): Promise<{ closed: number; alerts: string[] }> {
  const positions = await bankr.getPositions();
  const copyPositions = positions.filter(p => p.is_copy_trade);
  let closed = 0;
  const alerts: string[] = [];

  for (const pos of copyPositions) {
    try {
      const marketId = pos.market_id;
      if (!marketId) continue;

      const market = await polymarket.getMarketDetails(marketId);
      if (!market) continue;

      if (market.closed) {
        const yesPrice = market.tokens.find(t => t.outcome === "Yes")?.price || pos.current_price;
        const noPrice = market.tokens.find(t => t.outcome === "No")?.price || pos.current_price;
        const exitPrice = pos.direction === "YES" ? yesPrice : noPrice;
        const record = await bankr.closePosition(pos.id, exitPrice, "market_resolved");
        if (record) {
          await updateCopyTradeDrawdown(record.pnl);
          closed++;
        }
        continue;
      }

      const endDate = new Date(market.end_date_iso);
      const hoursToClose = (endDate.getTime() - Date.now()) / (60 * 60 * 1000);
      if (hoursToClose > 0 && hoursToClose < 6) {
        alerts.push(`⏰ ${pos.asset.slice(0, 60)} closes in ${hoursToClose.toFixed(1)}h — whale hasn't exited`);
      }
    } catch (err) {
      console.error(`[copy-trading] checkCopyTradeExits error for ${pos.id}:`, err instanceof Error ? err.message : err);
    }
  }

  return { closed, alerts };
}

export function formatWalletList(wallets: polymarket.WhaleWallet[]): string {
  if (wallets.length === 0) return "No tracked wallets.";
  return wallets.map((w, i) => {
    const status = w.enabled ? (w.observation_only ? "🔍" : "🟢") : "🔴";
    const lastChecked = w.last_checked > 0 ? timeAgo(w.last_checked) : "never";
    const statusLabel = w.observation_only ? "Observing" : w.pending_eviction ? "Evicting" : w.status;
    return `${status} *${i + 1}. ${w.alias}* (${w.niche})\n   Score: ${w.composite_score.toFixed(2)} | Win: ${(w.win_rate * 100).toFixed(0)}% | ${statusLabel}\n   Last: ${lastChecked} | Source: ${w.source}\n   \`${w.address.slice(0, 10)}...${w.address.slice(-6)}\``;
  }).join("\n\n");
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
