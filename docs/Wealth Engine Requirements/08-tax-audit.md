# Tax & Audit Tracking

## Purpose

Maintain complete, IRS-compliant records of all trading activity from day one. NY state taxes capital gains as ordinary income (no preferential long-term rate), so accurate tracking is essential regardless of holding period.

## Tax Tracking Requirements

### FIFO Cost Basis

Every trade creates a tax lot. When closing positions, FIFO (First In, First Out) determines which lot is sold:

```typescript
interface TaxLot {
  id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
  quantity: number;
  cost_basis: number;        // total cost including fees
  cost_per_unit: number;
  acquired_at: string;       // ISO timestamp
  disposed_at: string | null;
  proceeds: number | null;
  gain_loss: number | null;
  holding_period: "short" | "long";  // < 1 year = short, >= 1 year = long
  wash_sale_flagged: boolean;
  wash_sale_disallowed: number;  // disallowed loss amount
  venue: string;
  tx_hash: string | null;    // on-chain transaction hash
}
```

### Holding Period Classification

| Period | Classification | NY Tax Treatment |
|--------|---------------|------------------|
| < 1 year | Short-term | Ordinary income rate |
| >= 1 year | Long-term | Also ordinary income (NY has no preferential rate) |

Note: Federal has preferential long-term rates, so tracking holding period still matters for federal filing.

### Wash Sale Detection

A wash sale occurs when you sell at a loss and re-enter substantially identical property within 30 days (before or after).

**Detection logic:**
```
For each losing trade:
  Check if same asset was purchased within 30 days before OR after the loss
  If yes: flag as wash sale
  Disallowed loss = min(loss amount, cost of replacement shares)
  Add disallowed amount to cost basis of replacement shares
```

**Important:** The IRS position on crypto wash sales became explicit in 2025. We track them proactively.

### Form 8949 Export

Generate CSV matching IRS Form 8949 format:

| Column | Description |
|--------|-------------|
| (a) Description | "0.5 BTC" |
| (b) Date acquired | MM/DD/YYYY |
| (c) Date sold | MM/DD/YYYY |
| (d) Proceeds | Sale price minus fees |
| (e) Cost basis | Purchase price plus fees |
| (f) Code | Adjustment code (W for wash sale) |
| (g) Adjustment | Wash sale disallowed amount |
| (h) Gain or loss | Proceeds minus cost basis plus adjustment |

### Quarterly P&L Summary

```
Q1 2026 Summary:
  Total trades: 47
  Realized P&L: +$312.50
  Short-term gains: +$412.50
  Short-term losses: -$100.00
  Wash sale adjustments: $15.00
  Net taxable: +$327.50
  Estimated federal tax (24%): $78.60
  Estimated NY state tax (6.85%): $22.43
  Total estimated tax liability: $101.03
```

## Audit Trail

### Trade Decision Log

Every trade decision (execute, skip, hold) is recorded:

```
Decision Log Entry:
  thesis_id: "scout_2026_03_21_btc_001"
  decision: "approved"
  decided_by: "telegram_user"
  decided_at: "2026-03-21T14:30:00Z"
  thesis_snapshot: { ... full thesis at time of decision }
  execution_result: { fill_price, slippage, tx_hash }
```

### Vault Persistence

All significant events are saved to the knowledge vault for long-term audit:

| Path | Content |
|------|---------|
| `Scheduled Reports/Wealth Engines/Scout/` | Full cycle briefs |
| `Scheduled Reports/Wealth Engines/Oversight/` | Daily + weekly reports |
| `Scheduled Reports/Wealth Engines/Trades/` | Trade execution logs |
| `Scheduled Reports/Wealth Engines/Tax/` | Quarterly summaries |
| `Scheduled Reports/Wealth Engines/Autoresearch/` | Experiment logs |

### On-Chain Verification

For BNKR/Avantis trades:
- Store transaction hash for every order
- Cross-reference with on-chain data for audit verification
- Track gas fees as trading cost (deductible)

For Coinbase trades:
- Store Coinbase transaction ID
- Reconcile with Coinbase reporting (1099-DA)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/wealth-engines/tax/summary` | GET | Current year + quarterly breakdown |
| `/api/wealth-engines/tax/8949` | GET | Form 8949 CSV download |
| `/api/wealth-engines/tax/lots` | GET | All tax lots (open + closed) |
| `/api/wealth-engines/tax/wash-sales` | GET | Flagged wash sale entries |

## Done Looks Like

- [ ] Tax lot created for every trade with FIFO ordering
- [ ] Holding period tracked (acquired_at → disposed_at)
- [ ] Wash sale detection flagging re-entries within 30 days of loss
- [ ] Form 8949 CSV export matching IRS format
- [ ] Quarterly P&L summary with estimated tax liability
- [ ] Transaction hashes stored for on-chain verification
- [ ] Gas fees tracked as trading costs
- [ ] Audit trail saved to vault with full decision context
- [ ] `/tax` Telegram command showing YTD summary
- [ ] API endpoints for dashboard tax view
