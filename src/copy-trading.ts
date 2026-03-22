import { getPool } from "./db.js";
import * as polymarket from "./polymarket.js";
import * as bankr from "./bankr.js";

export interface TrackedWallet {
  address: string;
  alias: string;
  niche: string;
  win_rate: number;
  pnl: number;
  total_trades: number;
  last_checked: number;
  enabled: boolean;
  added_at: number;
  notes?: string;
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

const WALLETS_KEY = "copy_trading_wallets";
const SNAPSHOTS_KEY = "copy_trading_snapshots";
const COPY_TRADE_SIGNALS_KEY = "copy_trading_signals";
const COPY_TRADE_DRAWDOWN_KEY = "copy_trading_drawdown";

const COPY_TRADE_SIZE_USD = 50;
const MAX_CONCURRENT_COPY_TRADES = 3;
const PORTFOLIO_HARD_STOP_DRAWDOWN = 100;
const MIN_ODDS = 0.15;
const MAX_ODDS = 0.85;
const MIN_HOURS_TO_RESOLUTION = 24;
const MIN_VOLUME = 10000;
const MIN_WALLET_WIN_RATE = 65;

export async function getTrackedWallets(): Promise<TrackedWallet[]> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [WALLETS_KEY]);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      return res.rows[0].value;
    }
  } catch (err) {
    console.error("[copy-trading] getTrackedWallets error:", err instanceof Error ? err.message : err);
  }
  return [];
}

export async function saveTrackedWallets(wallets: TrackedWallet[]): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [WALLETS_KEY, JSON.stringify(wallets), Date.now()]
  );
}

export async function addWallet(wallet: Omit<TrackedWallet, "last_checked" | "added_at">): Promise<TrackedWallet> {
  const wallets = await getTrackedWallets();
  const existing = wallets.find(w => w.address.toLowerCase() === wallet.address.toLowerCase());
  if (existing) throw new Error(`Wallet ${wallet.address} already tracked as "${existing.alias}"`);

  const newWallet: TrackedWallet = {
    ...wallet,
    address: wallet.address.toLowerCase(),
    last_checked: 0,
    added_at: Date.now(),
  };
  wallets.push(newWallet);
  await saveTrackedWallets(wallets);
  console.log(`[copy-trading] Added wallet: ${newWallet.alias} (${newWallet.address.slice(0, 10)}...)`);
  return newWallet;
}

export async function removeWallet(address: string): Promise<boolean> {
  const wallets = await getTrackedWallets();
  const idx = wallets.findIndex(w => w.address.toLowerCase() === address.toLowerCase());
  if (idx === -1) return false;
  const removed = wallets.splice(idx, 1)[0];
  await saveTrackedWallets(wallets);
  console.log(`[copy-trading] Removed wallet: ${removed.alias}`);
  return true;
}

export async function updateWallet(address: string, updates: Partial<TrackedWallet>): Promise<TrackedWallet | null> {
  const wallets = await getTrackedWallets();
  const wallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
  if (!wallet) return null;
  Object.assign(wallet, updates);
  await saveTrackedWallets(wallets);
  return wallet;
}

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

export async function fetchWalletPositions(walletAddress: string): Promise<PositionSnapshot[]> {
  try {
    const activities = await polymarket.getWhaleActivities();
    const walletActivities = activities.filter(
      a => a.wallet_address.toLowerCase() === walletAddress.toLowerCase()
        && a.activity_type !== "position_exit"
    );

    return walletActivities.map(a => ({
      wallet_address: walletAddress.toLowerCase(),
      market_id: a.market_id,
      market_question: a.market_question,
      direction: a.direction,
      amount_usd: a.amount_usd,
      odds: a.current_odds,
      detected_at: a.detected_at,
    }));
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

export async function executeCopyTrade(signal: CopyTradeSignal): Promise<{
  success: boolean;
  position_id?: string;
  error?: string;
}> {
  const thesisId = `copy_${signal.wallet_address.slice(0, 8)}_${signal.market_id.slice(0, 12)}_${Date.now()}`;

  try {
    const killActive = await bankr.isKillSwitchActive();
    if (killActive) return { success: false, error: "Kill switch active" };

    const paused = await bankr.isPaused();
    if (paused) return { success: false, error: "System paused" };

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
      copy_trade_size_usd: COPY_TRADE_SIZE_USD,
    });

    if (result.position) {
      console.log(`[copy-trading] Copy trade opened: ${signal.market_question.slice(0, 60)} ${signal.direction} from ${signal.wallet_alias} (mode: ${mode})`);
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

export async function runCopyTradeScan(): Promise<{
  wallets_checked: number;
  new_entries: CopyTradeSignal[];
  exits: CopyTradeSignal[];
  trades_opened: number;
  trades_closed: number;
  errors: string[];
}> {
  const wallets = await getTrackedWallets();
  const enabledWallets = wallets.filter(w => w.enabled);
  const previousSnapshots = await getSnapshots();
  const newSnapshots: WalletSnapshot[] = [];
  const allSignals: CopyTradeSignal[] = [];
  const errors: string[] = [];
  let tradesOpened = 0;
  let tradesClosed = 0;

  for (const wallet of enabledWallets) {
    try {
      const currentPositions = await fetchWalletPositions(wallet.address);

      const prevSnapshot = previousSnapshots.find(
        s => s.wallet_address.toLowerCase() === wallet.address.toLowerCase()
      );
      const prevPositions = prevSnapshot?.positions || [];

      if (currentPositions.length === 0 && prevPositions.length > 0) {
        console.log(`[copy-trading] ${wallet.alias}: empty fetch with ${prevPositions.length} previous positions — skipping diff (stale data protection)`);
        newSnapshots.push({
          wallet_address: wallet.address,
          positions: prevPositions,
          taken_at: Date.now(),
        });
        await updateWallet(wallet.address, { last_checked: Date.now() });
        continue;
      }

      const signals = diffSnapshots(
        prevPositions,
        currentPositions,
        wallet.address,
        wallet.alias,
        wallet.win_rate
      );

      allSignals.push(...signals);

      newSnapshots.push({
        wallet_address: wallet.address,
        positions: currentPositions,
        taken_at: Date.now(),
      });

      await updateWallet(wallet.address, { last_checked: Date.now() });
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

  for (const entry of newEntries) {
    const evaluation = await evaluateCopyTradeSignal(entry);
    if (evaluation.passed) {
      const result = await executeCopyTrade(entry);
      if (result.success) tradesOpened++;
      else errors.push(`Failed to copy ${entry.market_question.slice(0, 40)}: ${result.error}`);
    } else {
      console.log(`[copy-trading] Signal rejected: ${entry.market_question.slice(0, 60)} — ${evaluation.failures.join("; ")}`);
    }
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
  };
}

export async function getWalletPerformance(): Promise<WalletPerformance[]> {
  const wallets = await getTrackedWallets();
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

export function formatWalletList(wallets: TrackedWallet[]): string {
  if (wallets.length === 0) return "No tracked wallets.";
  return wallets.map((w, i) => {
    const status = w.enabled ? "🟢" : "🔴";
    const lastChecked = w.last_checked > 0 ? timeAgo(w.last_checked) : "never";
    return `${status} *${i + 1}. ${w.alias}* (${w.niche})\n   Win: ${w.win_rate}% | P&L: $${w.pnl.toFixed(0)} | Last: ${lastChecked}\n   \`${w.address.slice(0, 10)}...${w.address.slice(-6)}\``;
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
