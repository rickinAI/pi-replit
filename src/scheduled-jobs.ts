import { getPool } from "./db.js";
import { getDarkNodeEmails, markDarkNodeProcessed } from "./gmail.js";
import * as gws from "./gws.js";
import { findOrCreateCalendar, createRecurringEvent } from "./calendar.js";
import { sendJobCompletionNotification } from "./telegram.js";

export interface ScheduledJob {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  schedule: {
    type: "daily" | "weekly" | "interval";
    hour: number;
    minute: number;
    daysOfWeek?: number[];
    intervalMinutes?: number;
  };
  enabled: boolean;
  lastRun?: string;
  lastResult?: string;
  lastStatus?: "success" | "partial" | "error";
}

interface ScheduledJobsConfig {
  jobs: ScheduledJob[];
  lastJobRun: Record<string, boolean>;
  timezone: string;
}

type RunAgentFn = (agentId: string, task: string, onProgress?: (info: { toolName: string; iteration: number }) => void) => Promise<{ response: string; timedOut: boolean; agentId?: string; agentName?: string; modelUsed?: string; tokensUsed?: { input: number; output: number } }>;
type BroadcastFn = (event: any) => void;
type KbCreateFn = (path: string, content: string) => Promise<any>;
type KbListFn = (path: string) => Promise<string>;
type KbMoveFn = (from: string, to: string) => Promise<string>;

function getJobSavePath(jobId: string, dateStr: string, safeName: string): string {
  if (jobId === "moodys-daily-intel") return `Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Brief.md`;
  if (jobId === "moodys-profile-updates") return `Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Profile-Updates.md`;
  if (jobId === "moodys-weekly-digest") return `Scheduled Reports/Moody's Intelligence/Weekly/${dateStr}-Digest.md`;
  if (jobId === "real-estate-daily-scan") return `Scheduled Reports/Real Estate/${dateStr}-Property-Scan.md`;
  if (jobId === "darknode-inbox-monitor") return `Scheduled Reports/Inbox Monitor/${dateStr}-${safeName}.md`;
  if (jobId === "life-audit") return `Scheduled Reports/Life-Audit/${dateStr}.md`;
  if (jobId === "daily-inbox-triage-am") return `Scheduled Reports/Inbox Cleanup/${dateStr}-AM-triage.md`;
  if (jobId === "daily-inbox-triage-pm") return `Scheduled Reports/Inbox Cleanup/${dateStr}-PM-triage.md`;
  if (jobId === "weekly-inbox-deep-clean") return `Scheduled Reports/Inbox Cleanup/${dateStr}-weekly-summary.md`;
  if (jobId === "baby-dashboard-weekly-update") return `Scheduled Reports/Baby Dashboard/${dateStr}-Weekly-Log.md`;
  if (jobId === "birthday-calendar-sync") return `Scheduled Reports/Birthday Sync/${dateStr}-Sync.md`;
  if (jobId === "scout-micro-scan") return `Scheduled Reports/Wealth Engines/Scout/${dateStr}-Micro-Scan.md`;
  if (jobId === "scout-full-cycle") return `Scheduled Reports/Wealth Engines/Scout/${dateStr}-Full-Cycle.md`;
  if (jobId === "polymarket-activity-scan") return `Scheduled Reports/Wealth Engines/Polymarket/${dateStr}-Activity-Scan.md`;
  if (jobId === "polymarket-full-cycle") return `Scheduled Reports/Wealth Engines/Polymarket/${dateStr}-Full-Cycle.md`;
  if (jobId === "weekly-memory-reflect") return `Scheduled Reports/Memory/${dateStr}-Weekly-Digest.md`;
  if (jobId === "bankr-execute") return `Scheduled Reports/Wealth Engines/BANKR/${dateStr}-Execution.md`;
  if (jobId === "oversight-health") return `Scheduled Reports/Wealth Engines/Oversight/${dateStr}-Health.md`;
  if (jobId === "oversight-weekly") return `Scheduled Reports/Wealth Engines/Oversight/${dateStr}-Weekly-Review.md`;
  if (jobId === "oversight-daily-summary") return `Scheduled Reports/Wealth Engines/Oversight/${dateStr}-Daily-Summary.md`;
  if (jobId === "oversight-shadow-refresh") return `Scheduled Reports/Wealth Engines/Oversight/${dateStr}-Shadow-Refresh.md`;
  if (jobId === "autoresearch-weekly") return `Scheduled Reports/Wealth Engines/Autoresearch/${dateStr}-Weekly-Optimization.md`;
  return `Scheduled Reports/${dateStr}-${safeName}.md`;
}

let jobStatusCache: Record<string, any> = {};

async function writeJobStatus(jobId: string, entry: { lastRun: string; status: string; savedTo: string | null; error: string | null }): Promise<void> {
  jobStatusCache[jobId] = entry;
  if (kbCreateFn) {
    await kbCreateFn("Scheduled Reports/job-status.json", JSON.stringify(jobStatusCache, null, 2));
  }
}

const DEFAULT_JOBS: ScheduledJob[] = [
  {
    id: "kb-organizer",
    name: "Knowledge Base Cleanup",
    agentId: "knowledge-organizer",
    prompt: `Audit the vault and produce a report — do NOT modify, move, or delete any files. Read-only scan only.

Check for these issues and list each finding with a suggested action:
1. Empty folders — list them and suggest removal
2. Orphaned or misplaced files — list them with suggested new locations
3. Duplicate or near-duplicate notes — list pairs with a suggestion to consolidate
4. Inconsistent naming — list files that don't follow conventions (kebab-case or Title Case) with suggested renames
5. Large files or folders that could be reorganised

Save the report to "Scheduled Reports/KB Audit Report.md" (overwrite previous). Format as a clear checklist so I can review and action items manually.`,
    schedule: { type: "daily", hour: 2, minute: 0 },
    enabled: false,
  },
  {
    id: "daily-news",
    name: "Daily News Brief",
    agentId: "deep-researcher",
    prompt: `Research and compile today's top news across these categories:
1. Technology & AI developments
2. Financial markets & economy
3. World events

For each story, provide a 2-3 sentence summary with context on why it matters.
Save the compiled brief to "Scheduled Reports/Daily News.md" (overwrite previous).`,
    schedule: { type: "daily", hour: 6, minute: 30 },
    enabled: false,
  },
  {
    id: "market-summary",
    name: "Market Summary",
    agentId: "analyst",
    prompt: `Analyze the current market conditions:
1. Check the watchlist stocks and crypto prices
2. Search X for ticker sentiment and market chatter — x_search("$GOLD OR $BTC OR $MSTR OR stock market") for real-time trader sentiment
3. Note any significant moves (>2%) with brief analysis
4. Summarize overall market sentiment (include X/social sentiment alongside data)
5. Flag any notable earnings or economic events today

Save the report to "Scheduled Reports/Market Summary.md" (overwrite previous).`,
    schedule: { type: "daily", hour: 7, minute: 30 },
    enabled: false,
  },
  {
    id: "moodys-daily-intel",
    name: "Moody's Intelligence Brief",
    agentId: "moodys",
    prompt: `You are a competitive intelligence analyst for Moody's Banking Solutions. Compile a comprehensive daily intelligence brief by ACTIVELY researching each category using web_search, web_fetch, AND x_search. You MUST call these tools — do not rely on prior knowledge.

RESEARCH METHOD — For EVERY category below:
1. Run web_search with the specified queries to find articles
2. Use web_fetch on the top 2-3 result URLs to read actual article content for richer summaries. If web_fetch returns empty/thin content (just nav text or errors), retry with render_page which uses a cloud browser with anti-bot protection
3. Run x_search with the specified queries for real-time signals
4. Write 3-5 bullet items per category (not just 1)

CATEGORY 1 — Moody's Corporate:
web_search("Moody's Analytics news 2026") AND web_search("site:moodys.com press release")
web_fetch the top 2 results from moodys.com
x_search("from:MoodysAnalytics OR from:MoodysInvSvc OR Moody's Analytics OR Credit Lens")
Focus: press releases, product launches, leadership, earnings, Credit Lens, Banking Solutions, KYC, risk analytics.

CATEGORY 2 — Banking Segment:
web_search("Moody's Credit Lens banking") AND web_search("Moody's Analytics banking product launch OR partnership")
web_fetch any relevant moodys.com product pages
x_search("Credit Lens OR Moody's banking OR OnlineALM OR BankFocus")
Focus: Credit Lens updates, customer wins, partnerships, banking vertical product news.

CATEGORY 3 — Competitor Intelligence:
Run SEPARATE searches for each competitor group:
web_search("Bloomberg Terminal AI 2026 OR Bloomberg Enterprise Data") → web_fetch top result
web_search("S&P Global Capital IQ AI OR S&P Market Intelligence 2026") → web_fetch top result
web_search("Fitch Solutions banking analytics OR Fitch Ratings 2026") → web_fetch top result
web_search("Nasdaq AxiomSL OR Nasdaq Financial Technology 2026") → web_fetch top result
web_search("nCino banking AI OR nCino 2026 news") → web_fetch top result
web_search("Quantexa banking OR Databricks financial services 2026")
web_search("ValidMind AI governance OR Regnology regulatory reporting 2026")
x_search("Bloomberg data AI OR S&P Global Capital IQ OR Fitch Solutions OR nCino")
x_search("Quantexa OR Databricks financial services OR ValidMind OR Regnology")
Write at least 3-5 competitor items with specific details from the articles.

CATEGORY 4 — Enterprise AI Trends:
web_search("agentic AI banking financial services 2026") → web_fetch top 2 results
web_search("enterprise LLM deployment regulated industries") → web_fetch top result
web_search("AI governance banking regulation EU AI Act")
x_search("agentic AI banking OR enterprise LLM financial services OR AI governance banking")
Focus: agentic AI in banking, LLM deployments, AI regulation, MCP adoption, CDM standards.

CATEGORY 5 — Industry Analyst Coverage:
web_search("site:celent.com Moody's OR Credit Lens OR banking AI")
web_search("site:chartis-research.com RiskTech100 OR credit risk technology 2026")
web_search("Forrester banking technology 2026 OR Gartner risk analytics OR IDC financial services AI")
x_search("from:CelentResearch OR from:Chartis_Research OR Celent banking OR RiskTech100")
web_fetch any analyst report pages found.

OUTPUT FORMAT — Do NOT use notes_create. Instead, output the full brief as your final response. The system will save it automatically. Format:

## 🏢 Moody's Corporate
- 🔴/🟡/🟢 {item summary — 1-2 sentences with specific details} ([source](url))
- {3-5 items minimum}

## 🏦 Banking Segment
- 🔴/🟡/🟢 {item summary} ([source](url))
- {3-5 items minimum}

## 🔍 Competitor Watch
- 🔴/🟡/🟢 **{Competitor Name}**: {what happened — specific details from article} ([source](url))
- {5-8 items covering multiple competitors}

## 🤖 Enterprise AI Trends
- 🔴/🟡/🟢 {item summary} ([source](url))
- {3-5 items minimum}

## 📊 Industry Analyst Coverage
- 🔴/🟡/🟢 {item summary} ([source](url))
- {3-5 items minimum}

## ⚡ Key Takeaways
1. {takeaway with strategic implication for Moody's}
2. {3-5 numbered takeaways}

IMPORTANT:
- Each category MUST have at least 3 bullets. If web_search returns few results, broaden the query or try alternate terms.
- Use web_fetch to read article content — summaries from search snippets alone are too thin. If web_fetch returns empty or blocked content, use render_page (cloud browser) instead.
- Tag each item: 🔴 High (directly impacts Moody's Banking), 🟡 Medium (industry trend), 🟢 Low (background).
- Do NOT produce a summary table — write full bullet content under each ## section header.
- Do NOT use notes_create or notes_append — just output the brief directly. The system saves it for you.
- Do NOT update competitor profiles — a separate job handles that.`,
    schedule: { type: "daily", hour: 6, minute: 0 },
    enabled: true,
  },
  {
    id: "moodys-profile-updates",
    name: "Moody's Profile Updates",
    agentId: "moodys",
    prompt: `Read today's intelligence brief and update competitor/analyst profiles with the findings.

STEP 1: Use notes_list on "Scheduled Reports/Moody's Intelligence/Daily/" to find today's brief (filename format: YYYY-MM-DD-Brief.md). Read it with notes_read.

STEP 2: For each competitor that has actual findings in the brief (not "No new developments"), use notes_append on the corresponding profile file to add a date-stamped entry:

Competitor Profiles — append to "Projects/Moody's/Competitive Intelligence/Competitor Profiles/{Name}.md":
- Bloomberg, S&P Global, Fitch, Nasdaq, nCino, QRM, Empyrean, Quantexa, Databricks, Regnology, FinregE, ValidMind

Industry Analyst Profiles — append to "Projects/Moody's/Competitive Intelligence/Industry Analysts/{Name}.md":
- Celent, Chartis Research, Forrester, Gartner, IDC

Entry format for each profile:
### {today's date YYYY-MM-DD}
- {bullet findings from today's brief}

Only append to profiles that had actual findings — skip any with "No new developments" or no mention in the brief.

After completing all updates, provide a summary of how many profiles were updated and which ones.`,
    schedule: { type: "daily", hour: 6, minute: 15 },
    enabled: true,
  },
  {
    id: "moodys-weekly-digest",
    name: "Moody's Weekly Strategic Digest",
    agentId: "moodys",
    prompt: `Generate the weekly Moody's strategic digest by reading and synthesising all daily intelligence briefs from this past week.

STEP 1: List files in "Scheduled Reports/Moody's Intelligence/Daily/" folder using notes_list.
STEP 2: Read every file matching "*-Brief.md" from the last 7 days.
STEP 3: Synthesise all daily briefs into the weekly digest format below.

Save using notes_create to "Scheduled Reports/Moody's Intelligence/Weekly/{today's date YYYY-MM-DD}-Digest.md":

# Moody's Weekly Strategic Digest — Week of {date}

## 📈 Week in Review
- {3-5 sentence executive summary of the most important developments}

## 🏢 Moody's Moves This Week
- {consolidated list of Moody's news, deduplicated across daily briefs}

## 🔍 Competitor Patterns
- {trends across competitors — who's gaining, who's shipping, strategic shifts}
- {any new partnerships, acquisitions, or product launches}

## 🤖 AI & Tech Trajectory
- {emerging patterns in enterprise AI, agentic AI, banking tech}
- {regulatory developments that impact Moody's strategy}

## 📊 Analyst Signals
- {any new rankings, quadrant reports, or vendor assessments}
- {shifts in analyst sentiment toward Moody's or competitors}

## ⚠️ Strategic Implications for Moody's Banking
- {what these developments mean for Rickin's data moat strategy}
- {opportunities to exploit or threats to watch}
- {specific actions or talking points for the coming week}

## 🎯 Recommended Focus This Week
- {top 3 things to pay attention to or act on}

Be thorough in reading all available daily briefs. If fewer than 7 daily briefs exist, work with what's available.`,
    schedule: { type: "weekly", hour: 7, minute: 0, daysOfWeek: [0] },
    enabled: true,
  },
  {
    id: "real-estate-daily-scan",
    name: "Daily Property Scan",
    agentId: "real-estate",
    prompt: `You are running the daily property scan. First read "Real Estate/Search Criteria.md" for full criteria and target areas.

For each of the 6 target areas, search for hidden gem properties matching: $1.3M–$1.8M, 4+ bedrooms, 3+ bathrooms, Houses.

STEP 1 — ZILLOW SEARCH: Use property_search with these locations (one call per area):
1. "Upper Saddle River, NJ" (also try "Ridgewood, NJ", "Ho-Ho-Kus, NJ")
2. "Montclair, NJ" (also try "Glen Ridge, NJ")
3. "Princeton, NJ" (also try "West Windsor, NJ")
4. "Garden City, NY" (also try "Manhasset, NY", "Great Neck, NY", "Cold Spring Harbor, NY")
5. "Tarrytown, NY" (also try "Scarsdale, NY", "Chappaqua, NY", "Bronxville, NY")
6. "Westport, CT" (also try "Darien, CT", "Stamford, CT")
For each search: set minPrice=1300000, maxPrice=1800000, minBeds=4, minBaths=3, sort="Newest".

STEP 2 — REDFIN SEARCH: Use redfin_search with these pre-verified URLs (one call per area):
1. https://www.redfin.com/city/19045/NJ/Upper-Saddle-River/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
2. https://www.redfin.com/city/35939/NJ/Montclair/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
3. https://www.redfin.com/city/15686/NJ/Princeton/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
4. https://www.redfin.com/city/7197/NY/Garden-City/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
5. https://www.redfin.com/city/18651/NY/Tarrytown/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
6. https://www.redfin.com/city/26700/CT/Westport/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
Only use redfin_autocomplete as a fallback if a URL returns no results.

STEP 3 — CROSS-REFERENCE: Compare Zillow and Redfin results by address. Flag:
- 🔵 Redfin-only exclusives (not on Zillow)
- 🟡 Zillow-only exclusives (not on Redfin)
- Note any price discrepancies between platforms

STEP 4 — DEEP DIVE: For the top 3-5 most interesting properties per area:
- Use property_details (Zillow zpid + location) for zestimate, open house info, listing details
- Use redfin_details (Redfin URL path) for photos, room details, market data

STEP 5 — X/SOCIAL SIGNALS: Search X for hyper-local real estate intel in each target area:
- x_search("Upper Saddle River NJ home OR house OR listing OR real estate")
- x_search("Montclair NJ real estate OR new listing OR open house")
- x_search("Princeton NJ home OR listing OR real estate market")
- x_search("Garden City NY real estate OR new listing")
- x_search("Tarrytown NY OR Scarsdale NY real estate OR home")
- x_search("Westport CT real estate OR new listing OR open house")
Look for: pocket listings, agent buzz about upcoming listings, local market sentiment, neighborhood chatter, price trend discussions. Note any relevant finds in the Executive Summary under "Social Signals".

STEP 6 — COMMUTE RESEARCH: For any area where the area note's commute section still has placeholder text ("To be populated") or only rough estimates, use web_search to look up current peak-hour transit schedules (NJ Transit, LIRR, Metro-North) and update the area note with actual commute times to Brookfield Place. Include route, transfers, and total door-to-door time.

For each property include: address, price, beds/baths, sqft, lot size, year built, key features, school district + rating, estimated commute to Brookfield Place (route + transfers + time from area note), days on market, listing URL(s) from both platforms, source (Zillow/Redfin/Both), and WHY it's interesting (1-2 sentences on character/charm/value).

Focus on:
- New listings (< 7 days on market)
- Price reductions
- Back-on-market properties
- Hidden gems: unique architecture, mature landscaping, walkable location, overlooked value
- Platform exclusives (listed on one but not the other)

Flag ⭐ standout properties (great schools + walkable + good commute + character) and save each to "Real Estate/Favorites/{Address slug}.md" with full details using notes_create.

OUTPUT — Save using notes_create to "Scheduled Reports/Real Estate/{today's date YYYY-MM-DD}-Property-Scan.md":

# Daily Property Scan — {today's date}

## ⚡ Executive Summary
- Total new listings found across all areas (Zillow + Redfin combined)
- Platform coverage: X on both, Y Zillow-only, Z Redfin-only
- Top gems of the day (⭐ properties)
- Price trends or market observations
- Commute comparison across areas
- 🐦 Social Signals: {any notable X chatter about target areas — pocket listings, agent buzz, market sentiment}

## 🏡 Upper Saddle River / Bergen County, NJ
{property listings with full details, source noted}

## 🏡 Montclair, NJ
{property listings with full details, source noted}

## 🏡 Princeton, NJ
{property listings with full details, source noted}

## 🏡 Long Island, NY
{property listings with full details, source noted}

## 🏡 Hudson Valley / Upstate NY
{property listings with full details, source noted}

## 🏡 Stamford–Westport, CT
{property listings with full details, source noted}

## 🎯 Top Gems Today
{ranked list of ⭐ properties with one-line reasons}

STEP 7 — MARKET OVERVIEW: After saving the scan report, overwrite "Real Estate/Market Overview.md" using notes_create with:
- Market Snapshot: today's date, total listings found, notable market trends
- Area Comparison table: | Area | Listings | Price Range | Avg $/sqft | New (<7d) |
- Commute Comparison: transit route + estimated time per area (from area notes)

After the Market Overview, append any notable new listings to the corresponding area file in "Real Estate/Areas/" using notes_append with a date-stamped header (### YYYY-MM-DD).

If no properties are found in an area, note "No new listings matching criteria" rather than omitting the section.`,
    schedule: { type: "daily", hour: 7, minute: 30 },
    enabled: false,
  },
  {
    id: "life-audit",
    name: "Weekly Life Audit",
    agentId: "deep-researcher",
    prompt: `You are running a proactive Life Audit for Rickin's family.

## Your Task
1. Read the constraints register: "About Me/Active Constraints.md"
2. Read all notes in "Vacation Planning/" for upcoming trips
3. Check the calendar for events in the next 60 days using calendar_list
4. For EACH upcoming trip or travel event:
   a. Cross-reference against EVERY active constraint (pregnancy weeks, age limits, passport requirements, visa needs, health restrictions)
   b. Web search for specific policies (airline pregnancy cutoffs, cruise line policies, resort age minimums, entry requirements for destination)
   c. Calculate exact dates/ages/weeks at time of travel
5. Check all Watch Items & Deadlines in the constraints file for approaching deadlines (within 14 days)
6. Check Document Checklist for any missing/unverified items needed before the next trip

## Output Format
Save a report to "Scheduled Reports/Life-Audit/" with:
- 🔴 CRITICAL: Conflicts that could prevent travel (denied boarding, expired documents, policy violations)
- 🟡 WARNING: Items that need attention within 14 days (deadlines, missing documents, insurance windows)
- 🟢 OK: Confirmed-clear items (gives confidence)
- 📋 ACTION ITEMS: Numbered list of specific things Rickin should do, ordered by urgency

Be thorough. Be specific. Calculate exact gestational weeks, exact ages, exact document dates. Don't assume — verify via web search.`,
    schedule: { type: "weekly", hour: 8, minute: 0, daysOfWeek: [0] },
    enabled: true,
  },
  {
    id: "daily-inbox-triage-am",
    name: "Daily Inbox Triage (AM)",
    agentId: "email-drafter",
    prompt: `You are running a daily inbox triage for Rickin. This is an autonomous job — do NOT use interview forms or ask for confirmation. Process everything directly.

## Step 1: Read Label Structure
Read "Preferences/Gmail Label Structure.md" from the vault using notes_read. This contains all label IDs you'll need.

## Step 2: Scan New Emails
Use email_list with query "in:inbox newer_than:1d" and maxResults 20. This scans only recent emails since roughly the last run. Process up to 50 emails. Track message IDs to avoid duplicates if you make multiple calls with narrower queries.

For each email, read the sender (From), subject, and snippet. If the category is unclear from metadata alone, use email_read to check the body.

## Step 3: Apply Labels
Apply labels using email_label with the label IDs from Step 1. Each email gets a CATEGORY label + an ACTION label:

### Category Rules (apply the FIRST match):
- From contains "@delta.com", "@jetblue.com", "@united.com", "@aa.com", "@spirit.com", "@southwest.com" OR subject contains "flight", "boarding pass", "itinerary" → Travel/Flights (Label_32)
- Subject contains "reservation", "hotel", "resort", "check-in", "booking" (non-flight) → Travel/Bookings (Label_31)
- Subject contains "Marriott", "Hilton", "Hyatt", "Airbnb" → Travel/Hotels (Label_33)
- From contains "@schools.nyc.gov" or "KCicio" OR subject contains "school", "class", "PTA", "curriculum" → Family/School (Label_22)
- From "pooja.bhatt@gmail.com" → Family/Pooja (Label_20)
- Subject contains "Reya" or relates to Reya's schedule → Family/Reya (Label_21)
- Subject contains "baby", "prenatal", "OB", "nursery", "registry" → Family/Baby (Label_23)
- From contains "@chase.com", "@bankofamerica.com", "@citi.com", "@wellsfargo.com", "@capitalone.com" OR subject contains "bank", "account", "statement" → Finance/Banking (Label_24)
- From contains "@fidelity.com", "@vanguard.com", "@schwab.com", "@robinhood.com" OR subject contains "investment", "portfolio", "dividend", "401k" → Finance/Investments (Label_25)
- Subject contains "tax", "W-2", "1099", "TurboTax", "CPA" → Finance/Tax (Label_26)
- Subject contains "bill", "invoice", "payment due", "autopay", "utility" → Finance/Bills (Label_27)
- From contains "@zillow.com", "@redfin.com", "@realtor.com", "@streeteasy.com" OR subject contains "listing", "open house", "property" → Real Estate/Listings (Label_28)
- Subject contains "mortgage", "pre-approval", "loan", "rate lock" → Real Estate/Mortgage (Label_30)
- Subject contains "closing", "title", "deed" (real estate) → Real Estate/Legal (Label_29)
- From contains "@healthfirst.org", "@mycharthealth.com", "@zocdoc.com" OR subject contains "appointment", "prescription", "lab results", "doctor" → Health (Label_34 for Pooja-related, Label_35 for Rickin-related)
- Subject contains "subscription", "renewal", "your plan", "membership" → Personal/Subscriptions (Label_36)
- From contains "@amazon.com", "@ebay.com", "@target.com" OR subject contains "order", "shipped", "delivered", "tracking" → Personal/Shopping (Label_37)
- Subject contains "insurance", "policy", "claim", "coverage", "premium" → Personal/Insurance (Label_38)

### Action Rules (apply ONE per email):
- Needs a response or decision from Rickin → ⚡ Action Required (Label_16)
- Rickin sent something and is waiting for reply → ⏳ Waiting On (Label_17)
- Confirms a scheduled event/appointment → 📅 Scheduled (Label_18)
- Informational only, no action needed → 🔁 Reference (Label_19)

## Step 4: Auto-Archive
After labeling, archive (email_archive) these:
- From "@linkedin.com" with subject containing "invitation", "endorsed", "who viewed", "new connection"
- From marketing/noreply addresses (sender contains "noreply@", "no-reply@", "marketing@", "news@", "promo@")
- Calendar sharing notifications ("added you to the shared calendar", "shared a calendar")
- Newsletters — if the body or snippet mentions "unsubscribe" and the sender is not a known contact (family, school, financial institution)

Do NOT archive:
- Anything labeled ⚡ Action Required (Label_16)
- Emails from Pooja, family, school, or financial institutions with action items
- Security alerts from Google, Apple, or banks — always keep these in inbox
- Anything you're unsure about — when in doubt, leave it in inbox

## Step 5: Save Triage Log
Save a lightweight log using notes_create to "Scheduled Reports/Inbox Cleanup/{today YYYY-MM-DD}-AM-triage.md":

# Inbox Triage — {date} AM

- Emails processed: X
- Labeled: X
- Archived: X
- Action items left in inbox: X

### Action Items
1. [Subject] — [Sender] — reason flagged

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "daily", hour: 6, minute: 0 },
    enabled: true,
  },
  {
    id: "daily-inbox-triage-pm",
    name: "Daily Inbox Triage (PM)",
    agentId: "email-drafter",
    prompt: `You are running a daily inbox triage for Rickin. This is an autonomous job — do NOT use interview forms or ask for confirmation. Process everything directly.

## Step 1: Read Label Structure
Read "Preferences/Gmail Label Structure.md" from the vault using notes_read. This contains all label IDs you'll need.

## Step 2: Scan New Emails
Use email_list with query "in:inbox newer_than:1d" and maxResults 20. This scans only recent emails since roughly the last run. Process up to 50 emails. Track message IDs to avoid duplicates if you make multiple calls with narrower queries.

For each email, read the sender (From), subject, and snippet. If the category is unclear from metadata alone, use email_read to check the body.

## Step 3: Apply Labels
Apply labels using email_label with the label IDs from Step 1. Each email gets a CATEGORY label + an ACTION label:

### Category Rules (apply the FIRST match):
- From contains "@delta.com", "@jetblue.com", "@united.com", "@aa.com", "@spirit.com", "@southwest.com" OR subject contains "flight", "boarding pass", "itinerary" → Travel/Flights (Label_32)
- Subject contains "reservation", "hotel", "resort", "check-in", "booking" (non-flight) → Travel/Bookings (Label_31)
- Subject contains "Marriott", "Hilton", "Hyatt", "Airbnb" → Travel/Hotels (Label_33)
- From contains "@schools.nyc.gov" or "KCicio" OR subject contains "school", "class", "PTA", "curriculum" → Family/School (Label_22)
- From "pooja.bhatt@gmail.com" → Family/Pooja (Label_20)
- Subject contains "Reya" or relates to Reya's schedule → Family/Reya (Label_21)
- Subject contains "baby", "prenatal", "OB", "nursery", "registry" → Family/Baby (Label_23)
- From contains "@chase.com", "@bankofamerica.com", "@citi.com", "@wellsfargo.com", "@capitalone.com" OR subject contains "bank", "account", "statement" → Finance/Banking (Label_24)
- From contains "@fidelity.com", "@vanguard.com", "@schwab.com", "@robinhood.com" OR subject contains "investment", "portfolio", "dividend", "401k" → Finance/Investments (Label_25)
- Subject contains "tax", "W-2", "1099", "TurboTax", "CPA" → Finance/Tax (Label_26)
- Subject contains "bill", "invoice", "payment due", "autopay", "utility" → Finance/Bills (Label_27)
- From contains "@zillow.com", "@redfin.com", "@realtor.com", "@streeteasy.com" OR subject contains "listing", "open house", "property" → Real Estate/Listings (Label_28)
- Subject contains "mortgage", "pre-approval", "loan", "rate lock" → Real Estate/Mortgage (Label_30)
- Subject contains "closing", "title", "deed" (real estate) → Real Estate/Legal (Label_29)
- From contains "@healthfirst.org", "@mycharthealth.com", "@zocdoc.com" OR subject contains "appointment", "prescription", "lab results", "doctor" → Health (Label_34 for Pooja-related, Label_35 for Rickin-related)
- Subject contains "subscription", "renewal", "your plan", "membership" → Personal/Subscriptions (Label_36)
- From contains "@amazon.com", "@ebay.com", "@target.com" OR subject contains "order", "shipped", "delivered", "tracking" → Personal/Shopping (Label_37)
- Subject contains "insurance", "policy", "claim", "coverage", "premium" → Personal/Insurance (Label_38)

### Action Rules (apply ONE per email):
- Needs a response or decision from Rickin → ⚡ Action Required (Label_16)
- Rickin sent something and is waiting for reply → ⏳ Waiting On (Label_17)
- Confirms a scheduled event/appointment → 📅 Scheduled (Label_18)
- Informational only, no action needed → 🔁 Reference (Label_19)

## Step 4: Auto-Archive
After labeling, archive (email_archive) these:
- From "@linkedin.com" with subject containing "invitation", "endorsed", "who viewed", "new connection"
- From marketing/noreply addresses (sender contains "noreply@", "no-reply@", "marketing@", "news@", "promo@")
- Calendar sharing notifications ("added you to the shared calendar", "shared a calendar")
- Newsletters — if the body or snippet mentions "unsubscribe" and the sender is not a known contact (family, school, financial institution)

Do NOT archive:
- Anything labeled ⚡ Action Required (Label_16)
- Emails from Pooja, family, school, or financial institutions with action items
- Security alerts from Google, Apple, or banks — always keep these in inbox
- Anything you're unsure about — when in doubt, leave it in inbox

## Step 5: Save Triage Log
Save a lightweight log using notes_create to "Scheduled Reports/Inbox Cleanup/{today YYYY-MM-DD}-PM-triage.md":

# Inbox Triage — {date} PM

- Emails processed: X
- Labeled: X
- Archived: X
- Action items left in inbox: X

### Action Items
1. [Subject] — [Sender] — reason flagged

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "daily", hour: 18, minute: 0 },
    enabled: true,
  },
  {
    id: "baby-dashboard-weekly-update",
    name: "Baby Dashboard Weekly Update",
    agentId: "deep-researcher",
    prompt: `You are updating the Baby Chikki #2 dashboard at rickin.live/pages/baby-dashboard. This is an autonomous job — do NOT ask for confirmation. Process everything directly.

## Key Facts
- Due date: July 7, 2026 (Week 40)
- OB: Dr. Boester
- Google Sheet: 1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU
- Dashboard slug: baby-dashboard

The dashboard HTML auto-calculates week/trimester/countdown/size via inline JS. Your job is to inject LIVE DATA that the static page can't compute on its own: appointments, names, tasks, and checklist progress from Google Sheets.

## Step 1: Pull OB Appointments from Calendar
Use calendar_list with timeMin = today, timeMax = 2026-07-15.
Filter events containing "Dr. Boester", "OB", "appointment", "glucose", "NICU", "nursery", "ultrasound", "tour".
Build a JSON array sorted by date: [{"title":"Video Appointment","date":"2026-03-19","time":"11:00 AM","detail":"Week 25 check-in via video call."},...]
- title: event summary
- date: YYYY-MM-DD format only (no time in date field)
- time: optional, human-readable time if available
- detail: optional one-line description

Always add a final entry: {"title":"🎉 Due Date","date":"2026-07-07","detail":"Baby Chikki #2 arrives! 💙"}

## Step 2: Pull Data from Google Sheets
Read these tabs from spreadsheet 1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU:

### 2a: Timeline (tab "Timeline")
Read range "Timeline!A1:F19". Row 1 = header (week, dates, trimester, development, milestone, status).
Find the current week: the row where column F contains "✅ Current Week".
Extract: week number, dates, trimester, development, milestone.

### 2b: Baby Names (tab "Baby Names")
Read range "Baby Names!A1:F16". Columns: A=name, B=meaning, C=origin, D=rickin rating, E=pooja rating, F=notes.
SKIP section header rows where col A == "⭐ FAVORITES" or "📋 SHORTLIST".
Favorites = rows where col D contains "⭐ Fav" or "🆕 New Fav" or col E contains "⭐ Fav".
Build two arrays of {name, meaning} — favorites and others.
If tab doesn't exist or is empty, skip (HTML has defaults).

### 2c: To-Do List (tab "To-Do List")
Read range "To-Do List!A1:F23". Columns: A=task, B=category, C=due_week, D=owner, E=status, F=notes.
Status values: "⬜ Pending", "🔄 In Progress", "✅ Done".
Build array: [{"text":"...","priority":"high","week":25,"done":false,"owner":"Rickin","category":"🏥 Medical"},...]
Mark done=true if status contains "✅ Done".
If tab doesn't exist, skip.

### 2d: Shopping List (tab "Shopping List")
Read range "Shopping List!A1:F40". Columns: A=category, B=item, C=priority, D=status, E=budget, F=notes.
Status values: "⬜ Pending", "🔄 In Progress", "✅ Done".
Count total items (non-header rows with item in col B) and items where col D contains "✅ Done". Format as "X/Y".
If tab doesn't exist, skip.

### 2e: Appointments (tab "Appointments")
Read range "Appointments!A1:E14". Columns: A=date, B=type, C=provider, D=notes, E=status.
Status values: "🗓️ Upcoming", "⬜ Scheduled", "✅ Done", "🎊 Due Date!".
Use this data to SUPPLEMENT the calendar data from Step 1 — if the Sheet has appointments not found in Calendar, include them. Merge by date, preferring Calendar data for duplicates.
If tab doesn't exist, skip (Step 1 calendar data is still used).

### 2f: Build Checklist Progress Object
Combine counts: {"shoppingDone":"5/39","tasksDone":"3/22"}
If any tab was missing, omit that field.

## Step 3: Inject Data into Dashboard HTML
Read the current file at "Scheduled Reports/baby-dashboard-source.html" using notes_read. If not found, read "data/pages/baby-dashboard.html".

DO NOT regenerate the HTML. Only inject data blocks before </body>. For each data type, if a \`<script id="..."\` block already exists, REPLACE it. Otherwise INSERT before </body>.

### 3a: Appointments
\`<script id="appt-data" type="application/json">[...appointments array...]</script>\`

### 3b: Tasks
\`<script id="tasks-data" type="application/json">[...tasks array...]</script>\`

### 3c: Checklist Progress
\`<script id="checklist-data" type="application/json">{"shoppingDone":"5/39","tasksDone":"3/22"}</script>\`

### 3d: Names (only if Sheets data available)
Find these lines and replace the array contents:
  var defaultFavNames = [...]
  var defaultOtherNames = [...]
Use format: {name:'Kian',meaning:'Ancient / King'}
Escape apostrophes in names/meanings with backslash.

Save the modified HTML using web_save with slug "baby-dashboard".

## Step 4: Output Summary

# Baby Dashboard Update — {date}
- **Week**: {N} of 40 ({trimester})
- **Appointments**: {count} injected, next: {title} on {date}
- **Names**: {fav count} favorites, {other count} others (source: Sheets / fallback)
- **To-Do**: {done}/{total} complete
- **Shopping List**: {bought}/{total} items
- **Hospital Bag**: {packed}/{total} packed
- **Dashboard**: Updated at rickin.live/pages/baby-dashboard

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "weekly", hour: 7, minute: 0, daysOfWeek: [1] },
    enabled: true,
  },
  {
    id: "baby-timeline-advance",
    name: "Baby Timeline Auto-Advance",
    agentId: "system",
    prompt: "Advances the ✅ Current Week marker in the Timeline tab to match the calculated pregnancy week.",
    schedule: { type: "weekly", hour: 23, minute: 59, daysOfWeek: [0] },
    enabled: true,
  },
  {
    id: "weekly-inbox-deep-clean",
    name: "Weekly Inbox Deep Clean",
    agentId: "email-drafter",
    prompt: `You are running a weekly deep clean of Rickin's inbox. This is an autonomous job — do NOT use interview forms or ask for confirmation. Process everything directly.

This job catches anything the daily triage jobs missed and does subscription detection.

## Step 1: Read Label Structure
Read "Preferences/Gmail Label Structure.md" from the vault using notes_read. This contains all label IDs you'll need.

## Step 2: Full Inbox Scan
Use email_list with query "in:inbox" and maxResults 20. This returns the 20 most recent inbox emails. Make additional calls with narrower queries (e.g., "in:inbox older_than:3d", "in:inbox from:linkedin.com", "in:inbox category:promotions") to catch more. Track message IDs to avoid duplicates. Aim for up to 100 emails total.

For each email, read the sender (From), subject, and snippet. If the category is unclear from metadata alone, use email_read to check the body.

## Step 3: Apply Labels (catch-all pass)
Apply labels using email_label with the label IDs from Step 1. Each email gets a CATEGORY label + an ACTION label. Skip emails that already have the correct labels from daily triage.

### Category Rules (apply the FIRST match):
- From contains "@delta.com", "@jetblue.com", "@united.com", "@aa.com", "@spirit.com", "@southwest.com" OR subject contains "flight", "boarding pass", "itinerary" → Travel/Flights (Label_32)
- Subject contains "reservation", "hotel", "resort", "check-in", "booking" (non-flight) → Travel/Bookings (Label_31)
- Subject contains "Marriott", "Hilton", "Hyatt", "Airbnb" → Travel/Hotels (Label_33)
- From contains "@schools.nyc.gov" or "KCicio" OR subject contains "school", "class", "PTA", "curriculum" → Family/School (Label_22)
- From "pooja.bhatt@gmail.com" → Family/Pooja (Label_20)
- Subject contains "Reya" or relates to Reya's schedule → Family/Reya (Label_21)
- Subject contains "baby", "prenatal", "OB", "nursery", "registry" → Family/Baby (Label_23)
- From contains "@chase.com", "@bankofamerica.com", "@citi.com", "@wellsfargo.com", "@capitalone.com" OR subject contains "bank", "account", "statement" → Finance/Banking (Label_24)
- From contains "@fidelity.com", "@vanguard.com", "@schwab.com", "@robinhood.com" OR subject contains "investment", "portfolio", "dividend", "401k" → Finance/Investments (Label_25)
- Subject contains "tax", "W-2", "1099", "TurboTax", "CPA" → Finance/Tax (Label_26)
- Subject contains "bill", "invoice", "payment due", "autopay", "utility" → Finance/Bills (Label_27)
- From contains "@zillow.com", "@redfin.com", "@realtor.com", "@streeteasy.com" OR subject contains "listing", "open house", "property" → Real Estate/Listings (Label_28)
- Subject contains "mortgage", "pre-approval", "loan", "rate lock" → Real Estate/Mortgage (Label_30)
- Subject contains "closing", "title", "deed" (real estate) → Real Estate/Legal (Label_29)
- From contains "@healthfirst.org", "@mycharthealth.com", "@zocdoc.com" OR subject contains "appointment", "prescription", "lab results", "doctor" → Health (Label_34 for Pooja-related, Label_35 for Rickin-related)
- Subject contains "subscription", "renewal", "your plan", "membership" → Personal/Subscriptions (Label_36)
- From contains "@amazon.com", "@ebay.com", "@target.com" OR subject contains "order", "shipped", "delivered", "tracking" → Personal/Shopping (Label_37)
- Subject contains "insurance", "policy", "claim", "coverage", "premium" → Personal/Insurance (Label_38)

### Action Rules (apply ONE per email):
- Needs a response or decision from Rickin → ⚡ Action Required (Label_16)
- Rickin sent something and is waiting for reply → ⏳ Waiting On (Label_17)
- Confirms a scheduled event/appointment → 📅 Scheduled (Label_18)
- Informational only, no action needed → 🔁 Reference (Label_19)

## Step 4: Auto-Archive
After labeling, archive (email_archive) these:
- From "@linkedin.com" with subject containing "invitation", "endorsed", "who viewed", "new connection"
- From marketing/noreply addresses (sender contains "noreply@", "no-reply@", "marketing@", "news@", "promo@")
- Calendar sharing notifications ("added you to the shared calendar", "shared a calendar")
- Newsletters — if the body or snippet mentions "unsubscribe" and the sender is not a known contact (family, school, financial institution)

Do NOT archive:
- Anything labeled ⚡ Action Required (Label_16)
- Emails from Pooja, family, school, or financial institutions with action items
- Security alerts from Google, Apple, or banks — always keep these in inbox
- Anything you're unsure about — when in doubt, leave it in inbox

## Step 5: Subscription Detection
While scanning, note any senders that appear to be subscriptions or recurring newsletters. After processing, append detected subscriptions to Google Sheet "Bhatt Family — Subscriptions & Bills Tracker" (spreadsheet ID: 1j5-EOdfIyqMFewDkXQ09a1o9HZAeSDGv4w52zWa0ELs) in the "Email Subscriptions" tab using sheets_append. Columns: Sender, Email Address, Type (newsletter/subscription/marketing), Frequency (daily/weekly/monthly), First Seen Date. Check existing rows first with sheets_read to avoid duplicates.

## Step 6: Save Weekly Summary
Save a summary report using notes_create to "Scheduled Reports/Inbox Cleanup/{today YYYY-MM-DD}-weekly-summary.md":

# Weekly Inbox Summary — {date}

## Week at a Glance
- Total emails processed: X
- Labeled: X | Archived: X | Left in inbox: X

## Label Breakdown
| Label | Count |
|-------|-------|
| Travel/Flights | 3 |
| Finance/Bills | 2 |
| Family/School | 4 |
| ... | ... |

## Action Items Remaining
1. [Subject] — [Sender] — flagged reason

## New Subscriptions Detected
- sender@domain.com — "Newsletter Name" — added to tracker sheet

## Archived Noise
- Xx LinkedIn notifications
- Xx promotional emails
- Xx newsletters

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "weekly", hour: 10, minute: 0, daysOfWeek: [6] },
    enabled: true,
  },
  {
    id: "birthday-calendar-sync",
    name: "Birthday Calendar Sync",
    agentId: "system",
    prompt: "Reads unsynced rows from the Birthday Tracker sheet and creates recurring annual events in the Birthdays calendar.",
    schedule: { type: "daily", hour: 8, minute: 0 },
    enabled: true,
  },
  {
    id: "darknode-inbox-monitor",
    name: "Inbox Monitor (@darknode)",
    agentId: "orchestrator",
    prompt: "",
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 180 },
    enabled: true,
  },
  {
    id: "scout-micro-scan",
    name: "SCOUT Micro-Scan",
    agentId: "scout",
    prompt: `Run a MICRO-SCAN cycle. This is a quick data refresh, not a full analysis.

1. Get the current watchlist via scout_watchlist
2. For each asset on the watchlist, run technical_analysis to get updated vote counts
3. Report the results as a brief table:

| Asset | Votes | Score | Regime | Entry Signal | Notes |
|-------|-------|-------|--------|-------------|-------|

4. Flag any assets where:
   - Vote count changed significantly since last scan
   - New entry signal appeared (votes crossed threshold)
   - RSI exit signal appeared (overbought/oversold)

Keep this concise — it runs every 30 minutes. No thesis generation, no Nansen/X checks, just signal refresh.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 30 },
    enabled: true,
  },
  {
    id: "scout-full-cycle",
    name: "SCOUT Full Cycle",
    agentId: "scout",
    prompt: `Run a FULL CYCLE analysis. This is a comprehensive market scan.

1. Check signal_quality FIRST — review your historical win rate for crypto signals. Note the modifier (boost/penalty/neutral) and factor it into confidence levels below.
2. Start with BTC technical_analysis — check BTC momentum for alt confirmation filter
3. Check crypto_trending and crypto_movers for candidates
4. Run technical_analysis on top 20 candidates, filter for vote_count >= 3/6
5. Run crypto_backtest on top 5 candidates (30-day data)
6. Check nansen_smart_money on top candidates (gracefully handle if API key not set)
7. Search X for sentiment on top 3 candidates
8. Generate thesis for each candidate meeting entry criteria (votes >= 4/6)
9. CONFIDENCE ADJUSTMENT: If signal_quality shows win rate >60%, you may upgrade MEDIUM→HIGH confidence. If win rate <40%, downgrade HIGH→MEDIUM. Include "Signal quality: X% win rate (N trades)" in thesis reasoning.
10. Include: vote count, technical score, regime, Nansen flow, backtest score, entry/stop/target
11. Provide a brief market overview at the top (BTC dominance, market regime, sector rotations)
12. List any watchlist changes (assets added/removed)

Output the full brief — the system will save it automatically. Do NOT use notes_create.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 240 },
    enabled: true,
  },
  {
    id: "polymarket-activity-scan",
    name: "Polymarket Activity Scan",
    agentId: "polymarket-scout",
    prompt: `Run a POLYMARKET ACTIVITY SCAN. Quick check of whale activity and market movements.

1. Check polymarket_whale_activity for new whale entries in the last 30 minutes
2. Check polymarket_consensus for any markets with 1+ whales aligned
3. For any new consensus, check polymarket_details to get current odds and volume
4. Report results as a brief summary:

**New Whale Activity:** X entries detected
**Active Consensus:** Y markets with 1+ whales

For each consensus market:
- Question, direction, whale count, avg score, current odds

Keep this concise — it runs every 30 minutes. Only flag actionable consensus.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 30 },
    enabled: true,
  },
  {
    id: "polymarket-full-cycle",
    name: "Polymarket Full Cycle",
    agentId: "polymarket-scout",
    prompt: `Run a FULL POLYMARKET CYCLE. Comprehensive prediction market scan.

1. Check signal_quality FIRST — review your historical win rate for polymarket signals. Note the modifier (boost/penalty/neutral) and factor it into confidence levels below.
2. Get trending markets via polymarket_trending (top 20 by volume)
3. Search specific categories: polymarket_search("crypto"), polymarket_search("politics"), polymarket_search("sports")
4. Filter markets: volume > $50K, odds between 15-85%, resolution > 12h (if volume > $100K) or > 24h
5. Check polymarket_whale_watchlist for tracked wallets
6. Check polymarket_whale_activity for recent whale movements
7. Run polymarket_consensus to detect aligned whale positions
8. Evaluate EACH qualifying market against TIERED thesis criteria (try all tiers top-down):
   - HIGH: 3+ whales aligned, avg score >= 0.8
   - MEDIUM: 2+ whales aligned, avg score >= 0.5
   - SPECULATIVE: 1 whale with score >= 0.7 (single-whale signal)
   - LOW: No whales needed IF volume > $500K AND odds 30-70% (volume-weighted edge)
   For ANY market matching ANY tier, generate thesis via save_pm_thesis with the tier as confidence.
   For LOW theses (volume-only): use empty whale_wallets=[], whale_avg_score=0, total_whale_amount=0.
9. CONFIDENCE ADJUSTMENT: If signal_quality shows win rate >60%, you may upgrade confidence one tier. If win rate <40%, downgrade one tier. Include "Signal quality: X% win rate (N trades)" in thesis reasoning.
10. Check existing polymarket_theses — retire any that have expired or resolved
11. Search X for sentiment on top markets

IMPORTANT: You MUST generate at least 1 thesis per cycle if ANY market qualifies at ANY tier. Prefer more theses at lower confidence over zero theses.

Output a full brief with:
- Market overview (total volume, trending categories)
- Whale activity summary
- Signal quality feedback (current win rate and modifier)
- New theses generated (with tier/confidence and reasoning)
- Existing theses status update
- Markets that were evaluated but rejected (with which criteria failed)

Do NOT use notes_create — the system saves automatically.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 240 },
    enabled: true,
  },
  {
    id: "bankr-execute",
    name: "BANKR Execute",
    agentId: "bankr",
    prompt: `Run a BANKR EXECUTION CYCLE. Check for actionable theses and execute trades.

1. Check scout_theses for active crypto theses with confidence HIGH or MEDIUM
2. Check polymarket_theses for active polymarket theses with confidence HIGH or MEDIUM
3. For each thesis NOT already associated with an open position (check bankr_positions):
   a. Run bankr_risk_check to validate the trade passes all risk rules
   b. If risk check passes AND tier is "autonomous" or "dead_zone":
      - For autonomous: execute directly via bankr_open_position
      - For dead_zone: execute but note it for Telegram flagging
   c. If tier is "human_required": log the thesis but do NOT execute — it needs Telegram approval
4. Report execution summary:
   - Theses evaluated (crypto + polymarket)
   - Trades executed (with position IDs)
   - Trades skipped (with reasons)
   - Current portfolio state

Keep this concise. The position monitor handles exits independently.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 30 },
    enabled: true,
  },
  {
    id: "weekly-memory-reflect",
    name: "Weekly Memory Reflect",
    agentId: "knowledge-organizer",
    prompt: `Run a WEEKLY MEMORY REFLECTION using Hindsight knowledge graph.

STEP 1: Call memory_reflect to consolidate and analyze all stored memories. This triggers the Hindsight reflect operation which surfaces patterns, recurring themes, and insights.

STEP 2: Call memory_recall with these queries to gather additional context:
- "important decisions and preferences" (top 15)
- "projects and work activities" (top 15)
- "family, personal life, and routines" (top 10)
- "action items and follow-ups" (top 10)

STEP 3: Synthesize the reflect results and recall results into a weekly digest:
- **Key Themes**: What topics dominated this week
- **Decisions Made**: Important choices or directions set
- **Active Projects**: Status of ongoing work
- **Personal**: Family, health, routine updates
- **Open Items**: Things that need follow-up
- **Patterns**: Recurring topics or concerns (from memory_reflect output)
- **Insights**: Meta-observations about activity patterns

Keep it concise and actionable. Save to the vault automatically.`,
    schedule: { type: "weekly", hour: 9, minute: 0, daysOfWeek: [0] },
    enabled: true,
  },
  {
    id: "oversight-health",
    name: "Oversight Health Check",
    agentId: "oversight",
    prompt: `Run a scheduled HEALTH CHECK on all Wealth Engines subsystems.

1. Call oversight_health_check — this evaluates SCOUT freshness, BANKR freshness, Polymarket SCOUT freshness, position monitor heartbeat, kill switch, pause state, circuit breaker, scout data freshness, and recent job failures.
2. Review the report. If overall status is "degraded" or "critical", flag the specific failing checks.
3. If any issues are found, they are auto-captured as improvement requests.
4. Save a brief summary (overall status + any failing checks) to the vault.

Keep the output concise — just the health status and any action items.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 240 },
    enabled: true,
  },
  {
    id: "oversight-weekly",
    name: "Oversight Weekly Review",
    agentId: "oversight",
    prompt: `Run the WEEKLY OVERSIGHT REVIEW for Wealth Engines.

STEP 1: Run oversight_health_check for current system state.
STEP 2: Run oversight_performance_review for 7-day trading performance stats.
STEP 3: Run oversight_cross_domain_exposure to detect crypto-Polymarket correlations.
STEP 4: Check oversight_improvement_queue for open improvement requests.
STEP 5: Check oversight_shadow_performance for shadow trading results.

STEP 6: Run oversight_thesis_review for adversarial bull/bear analysis of all active theses.
STEP 7: Run oversight_per_asset_losses to check for concentrated per-asset losses.

STEP 8: Compile a weekly report with these sections:
- System Health: overall status, any recurring issues this week
- Performance: win rate, total P&L, max drawdown, Sharpe ratio, best/worst trades, slippage
- Per-Asset Analysis: P&L by asset, flag concentrated losses
- Source Analysis: crypto_scout vs polymarket_scout signal quality comparison
- Cross-Domain Exposure: any correlated positions flagged
- Signal Attribution: which signal types contributed to wins vs losses
- Bull/Bear Thesis Review: summary of thesis verdicts from adversarial review
- Improvements: open items, resolved items, new items this week, routing summary
- Shadow Trading: shadow vs live comparison (if shadow trades exist)
- Recommendations: 3-5 specific action items for next week

Save the full report to the vault. Keep it actionable and data-driven.`,
    schedule: { type: "weekly", hour: 8, minute: 30, daysOfWeek: [0] },
    enabled: true,
  },
  {
    id: "oversight-daily-summary",
    name: "Oversight Daily Summary",
    agentId: "oversight",
    prompt: `Generate and send the daily performance summary.

1. Call oversight_daily_summary with send_telegram=true to generate and send the daily recap.
2. This covers: portfolio value, drawdown, today's trades, system health, and open issues.
3. Save a brief copy to the vault.

Keep it quick — the daily summary is meant to be a 30-second glance at the day's results.`,
    schedule: { type: "daily", hour: 20, minute: 0 },
    enabled: true,
  },
  {
    id: "oversight-shadow-refresh",
    name: "Oversight Shadow Price Refresh",
    agentId: "oversight",
    prompt: `Refresh shadow trade prices from live market data.

1. Call oversight_shadow_refresh to fetch current market prices for all open shadow trades.
2. This updates hypothetical P&L using real market data and auto-closes trades older than 7 days.
3. If any trades were updated or closed, note the counts.
4. Save a brief summary to the vault.

This ensures shadow/paper trading accurately tracks what BANKR would have earned.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 60 },
    enabled: true,
  },
  {
    id: "darknode-summary-9",
    name: "DarkNode Summary (9am)",
    agentId: "oversight",
    prompt: "Send the DarkNode summary to Telegram.",
    schedule: { type: "daily", hour: 9, minute: 0 },
    enabled: true,
  },
  {
    id: "darknode-summary-12",
    name: "DarkNode Summary (12pm)",
    agentId: "oversight",
    prompt: "Send the DarkNode summary to Telegram.",
    schedule: { type: "daily", hour: 12, minute: 0 },
    enabled: true,
  },
  {
    id: "darknode-summary-15",
    name: "DarkNode Summary (3pm)",
    agentId: "oversight",
    prompt: "Send the DarkNode summary to Telegram.",
    schedule: { type: "daily", hour: 15, minute: 0 },
    enabled: true,
  },
  {
    id: "darknode-summary-18",
    name: "DarkNode Summary (6pm)",
    agentId: "oversight",
    prompt: "Send the DarkNode summary to Telegram.",
    schedule: { type: "daily", hour: 18, minute: 0 },
    enabled: true,
  },
  {
    id: "darknode-summary-21",
    name: "DarkNode Summary (9pm)",
    agentId: "oversight",
    prompt: "Send the DarkNode summary to Telegram.",
    schedule: { type: "daily", hour: 21, minute: 0 },
    enabled: true,
  },
  {
    id: "autoresearch-weekly",
    name: "Autoresearch Strategy Optimization",
    agentId: "scout",
    prompt: `Run the WEEKLY AUTORESEARCH STRATEGY OPTIMIZATION.

1. Call autoresearch_run with domain "both" and experiments_per_domain 15.
2. This runs parameter mutation experiments against crypto signals and polymarket thresholds.
3. Each experiment backtests a parameter variation and keeps improvements >0.5%.
4. Report the results: experiments run, improvements found, score progression, parameters changed.
5. If improvements were found, note which parameters evolved and by how much.
6. Save the full results summary to the vault.

This autonomously evolves trading parameters based on recent market data.`,
    schedule: { type: "weekly", hour: 3, minute: 0, daysOfWeek: [0] },
    enabled: true,
  },
];

let config: ScheduledJobsConfig = {
  jobs: [...DEFAULT_JOBS],
  lastJobRun: {},
  timezone: "America/New_York",
};

let checkInterval: ReturnType<typeof setInterval> | null = null;
let jobRunning = false;
let currentRunningJobId: string | null = null;
let runAgentFn: RunAgentFn | null = null;
let broadcastFn: BroadcastFn | null = null;
let kbCreateFn: KbCreateFn | null = null;
let kbListFn: KbListFn | null = null;
let kbMoveFn: KbMoveFn | null = null;
let dbPoolFn: (() => any) | null = null;

async function writeJobHistory(jobId: string, jobName: string, status: string, summary: string | null, savedTo: string | null, durationMs: number | null, agentId?: string | null, modelUsed?: string | null, tokensInput?: number | null, tokensOutput?: number | null): Promise<void> {
  if (!dbPoolFn) return;
  try {
    const pool = dbPoolFn();
    await pool.query(
      `INSERT INTO job_history (job_id, job_name, status, summary, saved_to, duration_ms, agent_id, model_used, tokens_input, tokens_output) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [jobId, jobName, status, summary?.slice(0, 1000) || null, savedTo, durationMs, agentId || null, modelUsed || null, tokensInput || null, tokensOutput || null]
    );
    await pool.query(
      `DELETE FROM job_history WHERE id IN (
        SELECT id FROM job_history WHERE job_id = $1 ORDER BY created_at DESC OFFSET 50
      )`, [jobId]
    );
  } catch (err) {
    console.warn(`[scheduled-jobs] Failed to write job history:`, err);
  }
}

export async function getJobHistory(limit = 20): Promise<any[]> {
  if (!dbPoolFn) return [];
  try {
    const pool = dbPoolFn();
    const result = await pool.query(
      `SELECT job_id, job_name, status, summary, saved_to, duration_ms, created_at, agent_id, model_used, tokens_input, tokens_output FROM job_history ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    console.warn(`[scheduled-jobs] Failed to read job history:`, err);
    return [];
  }
}

export async function getCostSummary(): Promise<any> {
  if (!dbPoolFn) return { daily: 0, weekly: 0, monthly: 0, tokensIn: 0, tokensOut: 0, agents: [] };
  try {
    const pool = dbPoolFn();
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
    const monthAgo = new Date(now.getTime() - 30 * 86400000).toISOString();

    const result = await pool.query(
      `SELECT job_id, job_name, agent_id, model_used, tokens_input, tokens_output, status, created_at FROM job_history WHERE created_at > $1 ORDER BY created_at DESC`,
      [monthAgo]
    );
    const rows = result.rows;

    const rates: Record<string, { input: number; output: number }> = {
      haiku: { input: 1, output: 5 },
      sonnet: { input: 3, output: 15 },
      opus: { input: 15, output: 75 },
    };

    function calcCost(model: string | null, tokIn: number | null, tokOut: number | null): number {
      if (!model || !tokIn) return 0;
      let tier = "sonnet";
      if (model.includes("haiku")) tier = "haiku";
      else if (model.includes("opus")) tier = "opus";
      const r = rates[tier];
      return ((tokIn / 1_000_000) * r.input) + (((tokOut || 0) / 1_000_000) * r.output);
    }

    let daily = 0, weekly = 0, monthly = 0, tokensIn = 0, tokensOut = 0;
    const agentMap: Record<string, { name: string; cost: number; runs: number; errors: number; model: string | null; tokensIn: number; tokensOut: number }> = {};

    for (const r of rows) {
      const cost = calcCost(r.model_used, r.tokens_input, r.tokens_output);
      monthly += cost;
      tokensIn += (r.tokens_input || 0);
      tokensOut += (r.tokens_output || 0);
      const created = new Date(r.created_at);
      if (created >= new Date(weekAgo)) weekly += cost;
      if (r.created_at?.slice?.(0, 10) === todayStr || created.toISOString().slice(0, 10) === todayStr) daily += cost;
      const key = r.agent_id || r.job_id;
      if (!agentMap[key]) agentMap[key] = { name: r.job_name, cost: 0, runs: 0, errors: 0, model: null, tokensIn: 0, tokensOut: 0 };
      agentMap[key].cost += cost;
      agentMap[key].runs++;
      if (r.status === "error") agentMap[key].errors++;
      if (r.model_used) agentMap[key].model = r.model_used;
      agentMap[key].tokensIn += (r.tokens_input || 0);
      agentMap[key].tokensOut += (r.tokens_output || 0);
    }

    const agents = Object.entries(agentMap)
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => b.cost - a.cost);

    return { daily, weekly, monthly, tokensIn, tokensOut, agents, totalRuns: rows.length };
  } catch (err) {
    console.warn(`[scheduled-jobs] Failed to get cost summary:`, err);
    return { daily: 0, weekly: 0, monthly: 0, tokensIn: 0, tokensOut: 0, agents: [], totalRuns: 0 };
  }
}

async function archiveOldReports(): Promise<void> {
  if (!kbListFn || !kbMoveFn) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const folders = [
    { src: "Scheduled Reports/Moody's Intelligence/Daily", dest: "Archive/Moody's Intelligence/Daily" },
    { src: "Scheduled Reports/Moody's Intelligence/Weekly", dest: "Archive/Moody's Intelligence/Weekly" },
    { src: "Scheduled Reports/Real Estate", dest: "Archive/Real Estate" },
    { src: "Scheduled Reports/Life-Audit", dest: "Archive/Life-Audit" },
    { src: "Scheduled Reports/Inbox Cleanup", dest: "Archive/Inbox Cleanup" },
    { src: "Scheduled Reports/Baby Dashboard", dest: "Archive/Baby Dashboard" },
  ];

  let archived = 0;
  for (const { src, dest } of folders) {
    try {
      const listing = await kbListFn(src);
      let files: string[] = [];
      try {
        const parsed = JSON.parse(listing);
        files = (parsed.files || []).filter((f: string) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const filePath of files) {
        const basename = filePath.split("/").pop() || "";
        const dateMatch = basename.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch && dateMatch[1] < cutoffStr) {
          const destPath = `${dest}/${basename}`;
          try {
            await kbMoveFn(filePath, destPath);
            archived++;
          } catch (e) {
            console.error(`[scheduled-jobs] Archive move failed: ${filePath}`, e);
          }
        }
      }
    } catch {
    }
  }
  if (archived > 0) {
    console.log(`[scheduled-jobs] Archived ${archived} old brief(s)`);
  }
}

export async function init(): Promise<void> {
  try {
    const result = await getPool().query(`SELECT value FROM app_config WHERE key = 'scheduled_jobs'`);
    if (result.rows.length > 0) {
      const raw = result.rows[0].value;
      const existingIds = new Set((raw.jobs || []).map((j: any) => j.id));
      const mergedJobs = [...(raw.jobs || [])];
      for (const preset of DEFAULT_JOBS) {
        if (!existingIds.has(preset.id)) {
          mergedJobs.push(preset);
        }
      }
      config = {
        ...config,
        ...raw,
        jobs: mergedJobs,
        lastJobRun: raw.lastJobRun || {},
      };
      const kbJob = config.jobs.find(j => j.id === "kb-organizer");
      if (kbJob && kbJob.prompt.includes("Find and remove empty folders")) {
        const preset = DEFAULT_JOBS.find(j => j.id === "kb-organizer")!;
        kbJob.prompt = preset.prompt;
        await saveConfig();
      }
      const intelJob = config.jobs.find(j => j.id === "moodys-daily-intel");
      if (intelJob && intelJob.prompt.includes("AFTER saving the brief, update competitor")) {
        const preset = DEFAULT_JOBS.find(j => j.id === "moodys-daily-intel")!;
        intelJob.prompt = preset.prompt;
        console.log("[scheduled-jobs] Migrated moodys-daily-intel: removed profile update step (now handled by moodys-profile-updates)");
        await saveConfig();
      }
      const scanJob = config.jobs.find(j => j.id === "real-estate-daily-scan");
      if (scanJob && scanJob.enabled !== false) {
        scanJob.enabled = false;
        console.log("[scheduled-jobs] Migrated real-estate-daily-scan: disabled to save costs (paused)");
        await saveConfig();
      }
      const pmFullCycle = config.jobs.find(j => j.id === "polymarket-full-cycle");
      if (pmFullCycle && pmFullCycle.prompt.includes("score >= 0.6, 2+ whales")) {
        const preset = DEFAULT_JOBS.find(j => j.id === "polymarket-full-cycle")!;
        pmFullCycle.prompt = preset.prompt;
        console.log("[scheduled-jobs] Migrated polymarket-full-cycle: updated to tiered threshold criteria (HIGH/MEDIUM/SPECULATIVE/LOW)");
        await saveConfig();
      }
      const pmActivityScan = config.jobs.find(j => j.id === "polymarket-activity-scan");
      if (pmActivityScan && pmActivityScan.prompt.includes("2+ whales aligned")) {
        const preset = DEFAULT_JOBS.find(j => j.id === "polymarket-activity-scan")!;
        pmActivityScan.prompt = preset.prompt;
        console.log("[scheduled-jobs] Migrated polymarket-activity-scan: updated to 1+ whale threshold");
        await saveConfig();
      }
    } else {
      await saveConfig();
    }

    const alertsResult = await getPool().query(`SELECT value FROM app_config WHERE key = 'alerts'`);
    if (alertsResult.rows.length > 0) {
      config.timezone = alertsResult.rows[0].value.timezone || "America/New_York";
    }
  } catch (err) {
    console.error("[scheduled-jobs] Init error:", err);
  }
  console.log(`[scheduled-jobs] initialized (${config.jobs.length} jobs, ${config.jobs.filter(j => j.enabled).length} enabled)`);
}

async function saveConfig(): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('scheduled_jobs', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(config), Date.now()]
    );
  } catch (err) {
    console.error("[scheduled-jobs] Save config error:", err);
  }
}

export function getConfig(): ScheduledJobsConfig {
  return config;
}

export function getJobs(): ScheduledJob[] {
  return config.jobs;
}

export function getNextJob(): { name: string; id: string; time: string } | null {
  const tz = config.timezone || "America/New_York";
  const now = new Date();
  const nowLocal = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const nowH = nowLocal.getHours();
  const nowM = nowLocal.getMinutes();
  const nowDay = nowLocal.getDay();

  const enabled = config.jobs.filter(j => j.enabled);
  if (enabled.length === 0) return null;

  let bestJob: ScheduledJob | null = null;
  let bestMinutesAway = Infinity;

  for (const job of enabled) {
    if (job.schedule.type === "interval") {
      const intervalMs = (job.schedule.intervalMinutes || 30) * 60_000;
      const lastRunTime = job.lastRun ? new Date(job.lastRun).getTime() : 0;
      const elapsed = Date.now() - lastRunTime;
      const remaining = Math.max(0, intervalMs - elapsed);
      const mins = Math.ceil(remaining / 60_000);
      if (mins < bestMinutesAway) { bestMinutesAway = mins; bestJob = job; }
      continue;
    }

    const jH = job.schedule.hour;
    const jM = job.schedule.minute;

    if (job.schedule.type === "weekly" && job.schedule.daysOfWeek) {
      for (const dow of job.schedule.daysOfWeek) {
        let dayDiff = dow - nowDay;
        if (dayDiff < 0) dayDiff += 7;
        let mins = dayDiff * 1440 + (jH * 60 + jM) - (nowH * 60 + nowM);
        if (mins <= 0) mins += 7 * 1440;
        if (mins < bestMinutesAway) { bestMinutesAway = mins; bestJob = job; }
      }
    } else {
      let mins = (jH * 60 + jM) - (nowH * 60 + nowM);
      if (mins <= 0) mins += 1440;
      if (mins < bestMinutesAway) { bestMinutesAway = mins; bestJob = job; }
    }
  }

  if (!bestJob) return null;

  let timeStr: string;
  if (bestJob.schedule.type === "interval") {
    timeStr = `every ${bestJob.schedule.intervalMinutes || 30}m`;
  } else {
    const h = bestJob.schedule.hour;
    const m = bestJob.schedule.minute;
    const ampm = h < 12 ? "AM" : "PM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    timeStr = `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }

  return { name: bestJob.name, id: bestJob.id, time: timeStr };
}

export function updateConfig(partial: Partial<ScheduledJobsConfig>): ScheduledJobsConfig {
  if (partial.jobs) {
    config.jobs = partial.jobs;
  }
  if (partial.timezone) {
    config.timezone = partial.timezone;
  }
  saveConfig();
  return config;
}

export function updateJob(jobId: string, updates: Partial<ScheduledJob>): ScheduledJob | null {
  const job = config.jobs.find(j => j.id === jobId);
  if (!job) return null;
  if (updates.enabled !== undefined) job.enabled = updates.enabled;
  if (updates.name) job.name = updates.name;
  if (updates.prompt) job.prompt = updates.prompt;
  if (updates.schedule) job.schedule = { ...job.schedule, ...updates.schedule };
  if (updates.agentId) job.agentId = updates.agentId;
  saveConfig();
  return job;
}

export function addJob(job: Omit<ScheduledJob, "id">): ScheduledJob {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const newJob: ScheduledJob = { id, ...job };
  config.jobs.push(newJob);
  saveConfig();
  return newJob;
}

export function removeJob(jobId: string): boolean {
  const idx = config.jobs.findIndex(j => j.id === jobId);
  if (idx === -1) return false;
  config.jobs.splice(idx, 1);
  for (const key of Object.keys(config.lastJobRun)) {
    if (key === jobId || key.startsWith(`${jobId}_`)) {
      delete config.lastJobRun[key];
    }
  }
  saveConfig();
  return true;
}

function getNow(): Date {
  const nowStr = new Date().toLocaleString("en-US", { timeZone: config.timezone });
  return new Date(nowStr);
}

function getTodayKey(): string {
  const now = getNow();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function shouldJobRun(job: ScheduledJob, now: Date, nowMinutes: number, todayKey: string, dayOfWeek: number): boolean {
  if (job.schedule.type === "interval") {
    const intervalMs = (job.schedule.intervalMinutes || 30) * 60_000;
    const lastRunTime = job.lastRun ? new Date(job.lastRun).getTime() : 0;
    return (Date.now() - lastRunTime) >= intervalMs;
  }

  const targetMinutes = job.schedule.hour * 60 + job.schedule.minute;
  if (nowMinutes < targetMinutes || nowMinutes > targetMinutes + 2) return false;

  if (job.schedule.type === "weekly" && job.schedule.daysOfWeek) {
    if (!job.schedule.daysOfWeek.includes(dayOfWeek)) return false;
  }

  const runKey = `${job.id}_${todayKey}`;
  return !config.lastJobRun[runKey];
}

const BABY_SHEET_ID = "1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU";
const BABY_DUE_DATE = new Date("2026-07-07T00:00:00");

async function runTimelineAdvance(job: ScheduledJob): Promise<void> {
  console.log(`[scheduled-jobs] Timeline advance: calculating current week...`);
  try {
    const now = getNow();
    const msLeft = BABY_DUE_DATE.getTime() - now.getTime();
    const weeksLeft = Math.floor(msLeft / (7 * 24 * 60 * 60 * 1000));
    const currentWeek = Math.min(40, Math.max(1, 40 - weeksLeft));
    console.log(`[scheduled-jobs] Timeline advance: current pregnancy week = ${currentWeek}`);

    const raw = await gws.sheetsRead(BABY_SHEET_ID, "Timeline!A1:F50");
    const lines = raw.split("\n").filter(l => l.trim());

    let currentSheetRow = -1;
    let currentWeekLabel = "?";
    let targetSheetRow = -1;
    let targetWeekNum = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const rowMatch = line.match(/^Row\s+(\d+):\s*(.*)/);
      if (!rowMatch) continue;
      const sheetRow = parseInt(rowMatch[1], 10);
      const cols = rowMatch[2].split(" | ").map(c => c.trim());
      const weekNum = parseInt(cols[0], 10);
      if (isNaN(weekNum)) continue;
      if (cols.length > 5 && cols[5]?.includes("✅")) {
        currentSheetRow = sheetRow;
        currentWeekLabel = cols[0];
      }
      if (weekNum === currentWeek) {
        targetSheetRow = sheetRow;
        targetWeekNum = weekNum;
      }
    }

    if (targetSheetRow === -1) {
      console.log(`[scheduled-jobs] Timeline advance: week ${currentWeek} row not found in sheet, skipping`);
      job.lastRun = now.toISOString();
      job.lastResult = `Week ${currentWeek} row not found`;
      job.lastStatus = "error";
      await saveConfig();
      await writeJobHistory(job.id, job.name, "error", job.lastResult, null, null);
      return;
    }

    if (currentSheetRow === targetSheetRow) {
      console.log(`[scheduled-jobs] Timeline advance: already at week ${currentWeek}, no change needed`);
      job.lastRun = now.toISOString();
      job.lastResult = `Already at week ${currentWeek}`;
      job.lastStatus = "success";
      await saveConfig();
      await writeJobHistory(job.id, job.name, "success", job.lastResult, null, null);
      return;
    }

    if (currentSheetRow >= 0 && currentSheetRow !== targetSheetRow) {
      const prevWeek = parseInt(currentWeekLabel, 10);
      const oldStatus = prevWeek >= 40 ? "🎊 Due Jul 7!" : `✔️ Week ${prevWeek}`;
      await gws.sheetsUpdate(BABY_SHEET_ID, `Timeline!F${currentSheetRow}`, [[oldStatus]]);
      console.log(`[scheduled-jobs] Timeline advance: marked row ${currentSheetRow} as "${oldStatus}"`);
    }

    const newStatus = targetWeekNum >= 40 ? "🎊 Due Jul 7!" : "✅ Current Week";
    await gws.sheetsUpdate(BABY_SHEET_ID, `Timeline!F${targetSheetRow}`, [[newStatus]]);
    console.log(`[scheduled-jobs] Timeline advance: set row ${targetSheetRow} (week ${currentWeek}) as "${newStatus}"`);

    job.lastRun = now.toISOString();
    job.lastResult = `Advanced from week ${currentWeekLabel} to week ${currentWeek}`;
    job.lastStatus = "success";
    await saveConfig();
    await writeJobHistory(job.id, job.name, "success", job.lastResult, null, null);

    if (broadcastFn) {
      broadcastFn({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary: `Timeline advanced to week ${currentWeek}`,
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    console.error(`[scheduled-jobs] Timeline advance error:`, err);
    job.lastRun = new Date().toISOString();
    job.lastResult = String(err).slice(0, 300);
    job.lastStatus = "error";
    await saveConfig();
    await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 300), null, null);
  }
}

const BIRTHDAY_SHEET_ID = "1m4T-vniOylUSyVMSirtun5u9M6gJZlXS3iLy5hGxfuY";

const RELATIONSHIP_COLORS: Record<string, string> = {
  family: "11",
  friend: "9",
  coworker: "10",
};

async function runBirthdayCalendarSync(job: ScheduledJob): Promise<void> {
  console.log(`[scheduled-jobs] Birthday sync: reading sheet...`);
  const now = getNow();
  const results: string[] = [];
  let created = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const raw = await gws.sheetsRead(BIRTHDAY_SHEET_ID, "Sheet1!A1:F100");
    const lines = raw.split("\n").filter(l => l.trim());

    const rows: Array<{ sheetRow: number; name: string; relationship: string; birthday: string; birthYear: string; notes: string; synced: string }> = [];
    for (const line of lines) {
      const rowMatch = line.match(/^Row\s+(\d+):\s*(.*)/);
      if (!rowMatch) continue;
      const sheetRow = parseInt(rowMatch[1], 10);
      if (sheetRow === 1) continue;
      const cols = rowMatch[2].split(" | ").map(c => c.trim());
      rows.push({
        sheetRow,
        name: cols[0] || "",
        relationship: cols[1] || "",
        birthday: cols[2] || "",
        birthYear: cols[3] || "",
        notes: cols[4] || "",
        synced: cols[5] || "",
      });
    }

    const unsynced = rows.filter(r => r.name && r.birthday && r.synced.toLowerCase() !== "yes");
    if (unsynced.length === 0) {
      console.log(`[scheduled-jobs] Birthday sync: no unsynced rows`);
      job.lastRun = now.toISOString();
      job.lastResult = "No unsynced birthdays";
      job.lastStatus = "success";
      await saveConfig();
      await writeJobHistory(job.id, job.name, "success", "No unsynced birthdays", null, null);
      return;
    }

    console.log(`[scheduled-jobs] Birthday sync: ${unsynced.length} unsynced row(s) found`);

    const calendarId = await findOrCreateCalendar("Birthdays");
    console.log(`[scheduled-jobs] Birthday sync: using calendar ${calendarId}`);

    for (const row of unsynced) {
      try {
        const parts = row.birthday.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (!parts) {
          console.log(`[scheduled-jobs] Birthday sync: invalid date "${row.birthday}" for ${row.name}, skipping`);
          results.push(`⚠️ Skipped ${row.name}: invalid date "${row.birthday}"`);
          await gws.sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Invalid"]]);
          errors++;
          continue;
        }

        const month = parseInt(parts[1], 10);
        const day = parseInt(parts[2], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) {
          console.log(`[scheduled-jobs] Birthday sync: out-of-range date "${row.birthday}" for ${row.name}, skipping`);
          results.push(`⚠️ Skipped ${row.name}: invalid month/day "${row.birthday}"`);
          await gws.sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Invalid"]]);
          errors++;
          continue;
        }
        const testDate = new Date(2024, month - 1, day);
        if (testDate.getMonth() !== month - 1 || testDate.getDate() !== day) {
          console.log(`[scheduled-jobs] Birthday sync: non-existent date "${row.birthday}" for ${row.name}, skipping`);
          results.push(`⚠️ Skipped ${row.name}: date doesn't exist "${row.birthday}"`);
          await gws.sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Invalid"]]);
          errors++;
          continue;
        }

        let year = now.getFullYear();
        const thisYearDate = new Date(year, month - 1, day);
        if (thisYearDate < now) {
          year++;
        }
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

        const description = [
          `Relationship: ${row.relationship}`,
          row.birthYear ? `Birth Year: ${row.birthYear}` : "",
          row.notes ? `Notes: ${row.notes}` : "",
        ].filter(Boolean).join("\n");

        const colorId = RELATIONSHIP_COLORS[row.relationship.toLowerCase()] || "9";

        const eventId = await createRecurringEvent(calendarId, {
          summary: `🎂 ${row.name}'s Birthday`,
          date: dateStr,
          description,
          colorId,
          recurrence: ["RRULE:FREQ=YEARLY"],
          reminders: {
            useDefault: false,
            overrides: [{ method: "popup", minutes: 0 }],
          },
        });

        try {
          await gws.sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Yes"]]);
        } catch (markErr) {
          console.error(`[scheduled-jobs] Birthday sync: event created for ${row.name} (${eventId}) but failed to mark sheet — may create duplicate on next run`);
        }
        results.push(`✅ ${row.name} — ${row.birthday} (${row.relationship})`);
        created++;
        console.log(`[scheduled-jobs] Birthday sync: created event for ${row.name} (${eventId})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduled-jobs] Birthday sync error for ${row.name}:`, msg);
        results.push(`❌ ${row.name}: ${msg.slice(0, 100)}`);
        errors++;
      }
    }

    const summary = `Synced ${created}, skipped/errors ${errors + skipped}`;
    job.lastRun = now.toISOString();
    job.lastResult = summary;
    job.lastStatus = errors > 0 && created === 0 ? "error" : errors > 0 ? "partial" : "success";
    await saveConfig();

    const reportContent = `# Birthday Calendar Sync\n*${now.toLocaleString("en-US", { timeZone: "America/New_York" })}*\n\n## Results\n- Created: ${created}\n- Errors: ${errors}\n\n${results.join("\n")}`;
    const savePath = getJobSavePath(job.id, getTodayKey(), "Birthday-Sync");
    if (kbCreateFn) {
      try { await kbCreateFn(savePath, reportContent); } catch {}
    }

    await writeJobHistory(job.id, job.name, job.lastStatus, summary, savePath, null);

    if (broadcastFn) {
      broadcastFn({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary,
        timestamp: Date.now(),
      });
    }

    console.log(`[scheduled-jobs] Birthday sync complete: ${summary}`);
  } catch (err) {
    console.error(`[scheduled-jobs] Birthday sync error:`, err);
    job.lastRun = now.toISOString();
    job.lastResult = String(err).slice(0, 300);
    job.lastStatus = "error";
    await saveConfig();
    await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 300), null, null);
  }
}

async function runDarkNodeSummary(job: ScheduledJob): Promise<void> {
  console.log(`[scheduled-jobs] Running DarkNode summary (${job.name})...`);
  try {
    const { sendDarkNodeSummary } = await import("./telegram.js");
    await sendDarkNodeSummary();
    job.lastRun = new Date().toISOString();
    job.lastResult = "DarkNode summary sent to Telegram";
    job.lastStatus = "success";
    await saveConfig();
  } catch (err) {
    console.error("[scheduled-jobs] DarkNode summary error:", err);
    job.lastRun = new Date().toISOString();
    job.lastResult = `Error: ${err instanceof Error ? err.message : err}`;
    job.lastStatus = "error";
    await saveConfig();
  }
}

async function runInboxMonitor(job: ScheduledJob): Promise<void> {
  console.log(`[scheduled-jobs] Inbox monitor: checking for @darknode emails...`);
  let emails;
  try {
    emails = await getDarkNodeEmails();
  } catch (err) {
    console.error("[scheduled-jobs] Inbox monitor: failed to fetch emails:", err);
    job.lastRun = new Date().toISOString();
    job.lastResult = `Error fetching emails: ${err}`;
    job.lastStatus = "error";
    await saveConfig();
    return;
  }

  if (emails.length === 0) {
    console.log("[scheduled-jobs] Inbox monitor: no new @darknode emails");
    job.lastRun = new Date().toISOString();
    job.lastResult = "No new @darknode emails found";
    job.lastStatus = "success";
    await saveConfig();
    return;
  }

  console.log(`[scheduled-jobs] Inbox monitor: found ${emails.length} @darknode email(s)`);

  const results: string[] = [];
  for (const email of emails) {
    const prompt = `You received a forwarded email with a @darknode instruction. Process it accordingly.

**Instruction**: ${email.instruction}

**Email Details**:
- Subject: ${email.subject}
- From: ${email.from}
- Date: ${email.date}

**Email Body**:
${email.body}

Process the email content according to the instruction "${email.instruction}". Common instructions:
- "add to KB" / "save" = Save the email content as a well-organized note in the knowledge base
- "summarize" = Create a concise summary and save it
- "add to calendar" = Extract event details and create calendar events
- "action items" / "tasks" = Extract action items and create tasks
- For any other instruction, use your best judgment to fulfill the request

After processing, briefly confirm what you did.`;

    try {
      const agentResult = await runAgentFn!(job.agentId === "orchestrator" ? "deep-researcher" : job.agentId, prompt);
      results.push(`## ${email.subject}\n**Instruction**: ${email.instruction}\n**Result**: ${agentResult.response}`);
      await markDarkNodeProcessed(email.messageId);
      console.log(`[scheduled-jobs] Inbox monitor: processed "${email.subject}" (${email.instruction})`);
    } catch (err) {
      results.push(`## ${email.subject}\n**Instruction**: ${email.instruction}\n**Error**: ${err}`);
      console.error(`[scheduled-jobs] Inbox monitor: failed to process "${email.subject}":`, err);
    }
  }

  const fullResult = results.join("\n\n---\n\n");
  job.lastRun = new Date().toISOString();
  job.lastResult = fullResult.slice(0, 500);
  job.lastStatus = results.some(r => r.includes("**Error**")) ? "partial" : "success";
  await saveConfig();

  let inboxSavePath: string | null = null;
  if (kbCreateFn) {
    const todayKey = getTodayKey();
    const timestamp = new Date().toLocaleString("en-US", { timeZone: config.timezone }).replace(/[/:]/g, "-").replace(/,\s*/g, "_");
    inboxSavePath = `Scheduled Reports/Inbox Monitor/${todayKey}-${timestamp}.md`;
    try {
      await kbCreateFn(inboxSavePath, `# Inbox Monitor Results\n*Processed: ${new Date().toLocaleString("en-US", { timeZone: config.timezone })}*\n*Emails processed: ${emails.length}*\n\n${fullResult}`);
    } catch {}
    try {
      await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus!, savedTo: inboxSavePath, error: null });
    } catch {}
  }

  await writeJobHistory(job.id, job.name, job.lastStatus || "success", `Processed ${emails.length} email(s)`, inboxSavePath, null);

  if (broadcastFn) {
    broadcastFn({
      type: "job_complete",
      jobId: job.id,
      jobName: job.name,
      summary: `Processed ${emails.length} @darknode email(s): ${emails.map(e => e.instruction).join(", ")}`,
      timestamp: Date.now(),
    });
  }
}

const WEALTH_ENGINE_AGENTS = new Set(["scout", "bankr", "polymarket-scout", "oversight"]);

async function isWealthEnginesPaused(): Promise<boolean> {
  try {
    const pool = dbPoolFn ? dbPoolFn() : getPool();
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    return res.rows.length > 0 && res.rows[0].value === true;
  } catch {
    return false;
  }
}

async function checkJobs(): Promise<void> {
  if (jobRunning || !runAgentFn) return;

  const now = getNow();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayKey = getTodayKey();
  const dayOfWeek = now.getDay();

  let wePaused: boolean | null = null;

  for (const job of config.jobs) {
    if (!job.enabled) continue;
    if (!shouldJobRun(job, now, nowMinutes, todayKey, dayOfWeek)) continue;

    if (WEALTH_ENGINE_AGENTS.has(job.agentId)) {
      if (wePaused === null) wePaused = await isWealthEnginesPaused();
      if (wePaused) {
        console.log(`[scheduled-jobs] Skipping ${job.name} — Wealth Engines paused`);
        continue;
      }
    }

    if (job.schedule.type !== "interval") {
      const runKey = `${job.id}_${todayKey}`;
      config.lastJobRun[runKey] = true;
      await saveConfig();
    }

    jobRunning = true;
    currentRunningJobId = job.id;
    console.log(`[scheduled-jobs] Running job: ${job.name} (${job.id})`);

    if (broadcastFn) {
      broadcastFn({
        type: "job_start",
        jobId: job.id,
        jobName: job.name,
        timestamp: Date.now(),
      });
    }

    try {
      if (job.id.startsWith("darknode-summary-")) {
        await runDarkNodeSummary(job);
      } else if (job.id === "darknode-inbox-monitor") {
        await runInboxMonitor(job);
      } else if (job.id === "baby-timeline-advance") {
        await runTimelineAdvance(job);
      } else if (job.id === "birthday-calendar-sync") {
        await runBirthdayCalendarSync(job);
      } else {
        const jobStartMs = Date.now();
        const progressCb = (info: { toolName: string; iteration: number }) => {
          if (broadcastFn) {
            broadcastFn({ type: "job_progress", jobId: job.id, jobName: job.name, toolName: info.toolName, timestamp: Date.now() });
          }
        };
        const agentResult = await runAgentFn(job.agentId, job.prompt, progressCb);
        const result = agentResult.response;
        const isPartial = agentResult.timedOut || result.includes("⚠️ PARTIAL");
        job.lastRun = new Date().toISOString();
        job.lastResult = result.slice(0, 500);
        job.lastStatus = isPartial ? "partial" : "success";
        await saveConfig();

        const dateStr = todayKey;
        const safeName = job.name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-");
        const savePath = getJobSavePath(job.id, dateStr, safeName);
        let vaultSaved = false;
        if (kbCreateFn) {
          try {
            await kbCreateFn(savePath, `# ${job.name}\n*Generated: ${new Date().toLocaleString("en-US", { timeZone: config.timezone })}*\n\n${result}`);
            vaultSaved = true;
          } catch (e) {
            console.error(`[scheduled-jobs] Failed to save to vault:`, e);
          }
          try {
            await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus!, savedTo: vaultSaved ? savePath : null, error: vaultSaved ? null : "vault save failed" });
          } catch {}
        }

        if (broadcastFn) {
          broadcastFn({
            type: "job_complete",
            jobId: job.id,
            jobName: job.name,
            summary: result.slice(0, 300),
            savedTo: vaultSaved ? savePath : null,
            status: job.lastStatus,
            timestamp: Date.now(),
          });

          if (job.id === "life-audit" && result.includes("🔴 CRITICAL")) {
            const criticalLine = result.split("\n").find(l => l.includes("🔴 CRITICAL")) || "Critical finding detected";
            broadcastFn({
              type: "alert",
              alertType: "life-audit-critical",
              title: "🔴 Life Audit: Critical Finding",
              content: criticalLine.slice(0, 300),
              timestamp: Date.now(),
            });
            console.log(`[scheduled-jobs] Life Audit CRITICAL alert broadcast`);
          }
        }

        console.log(`[scheduled-jobs] Job completed${isPartial ? " (partial)" : ""}: ${job.name}`);
        await writeJobHistory(job.id, job.name, job.lastStatus || "success", result.slice(0, 500), vaultSaved ? savePath : null, Date.now() - jobStartMs, agentResult.agentId, agentResult.modelUsed, agentResult.tokensUsed?.input, agentResult.tokensUsed?.output);

        sendJobCompletionNotification({
          jobId: job.id,
          jobName: job.name,
          status: (job.lastStatus || "success") as "success" | "partial" | "error",
          summary: result.slice(0, 500),
          durationMs: Date.now() - jobStartMs,
        }).catch(err => console.warn("[scheduled-jobs] Telegram notification failed:", err));

        if (job.id === "scout-full-cycle" || job.id === "scout-micro-scan") {
          try {
            const pool = dbPoolFn ? dbPoolFn() : null;
            if (pool) {
              const briefKey = job.id === "scout-full-cycle" ? "scout_latest_brief" : "scout_latest_micro_scan";
              await pool.query(
                `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
                [briefKey, JSON.stringify(result.slice(0, 10000)), Date.now()]
              );
              console.log(`[scheduled-jobs] Saved SCOUT brief to ${briefKey}`);
            }
          } catch (e) {
            console.warn(`[scheduled-jobs] Failed to save SCOUT brief:`, e);
          }
        }

        if ((job.id.startsWith("moodys") || job.id.startsWith("real-estate") || job.id === "life-audit" || job.id === "weekly-inbox-deep-clean" || job.id === "baby-dashboard-weekly-update") && kbListFn && kbMoveFn) {
          await archiveOldReports();
        }
      }
    } catch (err) {
      job.lastRun = new Date().toISOString();
      job.lastResult = String(err);
      job.lastStatus = "error";
      await saveConfig();
      if (kbCreateFn) {
        try { await writeJobStatus(job.id, { lastRun: job.lastRun, status: "error", savedTo: null, error: String(err).slice(0, 300) }); } catch {}
      }
      await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 500), null, null);
      if (broadcastFn) {
        broadcastFn({
          type: "job_complete",
          jobId: job.id,
          jobName: job.name,
          summary: String(err).slice(0, 200),
          savedTo: null,
          status: "error",
          timestamp: Date.now(),
        });
      }
      sendJobCompletionNotification({
        jobId: job.id,
        jobName: job.name,
        status: "error",
        summary: String(err).slice(0, 500),
      }).catch(e => console.warn("[scheduled-jobs] Telegram error notification failed:", e));
      console.error(`[scheduled-jobs] Job failed: ${job.name}`, err);
    } finally {
      jobRunning = false;
      currentRunningJobId = null;
    }
  }

  const keys = Object.keys(config.lastJobRun);
  if (keys.length > 100) {
    const sorted = keys.sort();
    for (let i = 0; i < keys.length - 50; i++) {
      delete config.lastJobRun[sorted[i]];
    }
    saveConfig();
  }
}

export function startJobSystem(
  runAgent: RunAgentFn,
  broadcast: BroadcastFn,
  kbCreate?: KbCreateFn,
  kbList?: KbListFn,
  kbMove?: KbMoveFn,
  getDbPool?: () => any,
): void {
  runAgentFn = runAgent;
  broadcastFn = broadcast;
  kbCreateFn = kbCreate || null;
  kbListFn = kbList || null;
  kbMoveFn = kbMove || null;
  dbPoolFn = getDbPool || null;

  checkInterval = setInterval(() => {
    checkJobs().catch(err => console.error("[scheduled-jobs] Check error:", err));
  }, 60_000);

  const enabledJobs = config.jobs.filter(j => j.enabled);
  const jobList = enabledJobs.length > 0
    ? enabledJobs.map(j => {
        if (j.schedule.type === "interval") return `${j.name}/every ${j.schedule.intervalMinutes || 30}m`;
        return `${j.name}/${j.schedule.hour}:${String(j.schedule.minute).padStart(2, "0")}`;
      }).join(", ")
    : "none enabled";
  console.log(`[scheduled-jobs] System started — ${jobList} (${config.timezone})`);
}

export function getRunningJob(): { running: boolean; jobId: string | null; jobName: string | null } {
  if (!jobRunning || !currentRunningJobId) return { running: false, jobId: null, jobName: null };
  const job = config.jobs.find(j => j.id === currentRunningJobId);
  return { running: true, jobId: currentRunningJobId, jobName: job?.name || null };
}

export function stopJobSystem(): void {
  if (checkInterval) clearInterval(checkInterval);
  runAgentFn = null;
  broadcastFn = null;
  console.log("[scheduled-jobs] System stopped");
}

export async function triggerJob(jobId: string): Promise<string> {
  const job = config.jobs.find(j => j.id === jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!runAgentFn) throw new Error("Job system not started");
  if (jobRunning) throw new Error("Another job is currently running");

  jobRunning = true;
  currentRunningJobId = job.id;
  console.log(`[scheduled-jobs] Manual trigger: ${job.name}`);

  if (broadcastFn) {
    broadcastFn({ type: "job_start", jobId: job.id, jobName: job.name, timestamp: Date.now() });
  }

  try {
    if (job.id.startsWith("darknode-summary-")) {
      await runDarkNodeSummary(job);
      return job.lastResult || "DarkNode summary sent";
    }

    if (job.id === "darknode-inbox-monitor") {
      await runInboxMonitor(job);
      return job.lastResult || "Inbox monitor completed";
    }

    if (job.id === "baby-timeline-advance") {
      await runTimelineAdvance(job);
      return job.lastResult || "Timeline advance completed";
    }

    if (job.id === "birthday-calendar-sync") {
      await runBirthdayCalendarSync(job);
      return job.lastResult || "Birthday sync completed";
    }

    const triggerStartMs = Date.now();
    const progressCb = (info: { toolName: string; iteration: number }) => {
      if (broadcastFn) {
        broadcastFn({ type: "job_progress", jobId: job.id, jobName: job.name, toolName: info.toolName, timestamp: Date.now() });
      }
    };
    const agentResult = await runAgentFn(job.agentId, job.prompt, progressCb);
    let result = agentResult.response;
    const isPartial = agentResult.timedOut || result.includes("⚠️ PARTIAL");
    job.lastRun = new Date().toISOString();
    job.lastResult = result.slice(0, 500);
    job.lastStatus = isPartial ? "partial" : "success";
    await saveConfig();

    const todayKey = getTodayKey();
    const safeName = job.name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-");
    const savePath = getJobSavePath(job.id, todayKey, safeName);

    if (job.id === "moodys-daily-intel") {
      try {
        const fs = await import("fs");
        const path = await import("path");
        const briefDir = path.join(process.cwd(), "data/vault/Scheduled Reports/Moody's Intelligence/Daily");
        if (fs.existsSync(briefDir)) {
          const files = fs.readdirSync(briefDir).filter((f: string) => f.endsWith("-Brief.md") && f > `${todayKey}-Brief.md`).sort().reverse();
          for (const fname of files) {
            const content = fs.readFileSync(path.join(briefDir, fname), "utf-8");
            if (content.length > 1000 && content.includes("## 🏢")) {
              result = content;
              console.log(`[scheduled-jobs] Moody's brief: using agent-saved file ${fname} (${result.length} chars)`);
              break;
            }
          }
        }
      } catch (e) { console.error("[scheduled-jobs] Moody's brief recovery failed:", e); }
    }

    let vaultSaved = false;
    if (kbCreateFn) {
      try {
        await kbCreateFn(savePath, `# ${job.name}\n*Generated: ${new Date().toLocaleString("en-US", { timeZone: config.timezone })}*\n\n${result}`);
        vaultSaved = true;
      } catch {}
      try { await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus!, savedTo: vaultSaved ? savePath : null, error: vaultSaved ? null : "vault save failed" }); } catch {}
    }

    if (job.id === "scout-full-cycle" || job.id === "scout-micro-scan") {
      try {
        const pool = dbPoolFn ? dbPoolFn() : null;
        if (pool) {
          const briefKey = job.id === "scout-full-cycle" ? "scout_latest_brief" : "scout_latest_micro_scan";
          await pool.query(
            `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
            [briefKey, JSON.stringify(result.slice(0, 10000)), Date.now()]
          );
          console.log(`[scheduled-jobs] Saved SCOUT brief to ${briefKey} (manual trigger)`);
        }
      } catch (e) {
        console.warn(`[scheduled-jobs] Failed to save SCOUT brief:`, e);
      }
    }

    if ((job.id.startsWith("moodys") || job.id.startsWith("real-estate") || job.id === "life-audit" || job.id === "weekly-inbox-deep-clean" || job.id === "baby-dashboard-weekly-update") && kbListFn && kbMoveFn) {
      await archiveOldReports();
    }

    await writeJobHistory(job.id, job.name, job.lastStatus || "success", result.slice(0, 500), vaultSaved ? savePath : null, Date.now() - triggerStartMs, agentResult.agentId, agentResult.modelUsed, agentResult.tokensUsed?.input, agentResult.tokensUsed?.output);

    sendJobCompletionNotification({
      jobId: job.id,
      jobName: job.name,
      status: (job.lastStatus || "success") as "success" | "partial" | "error",
      summary: result.slice(0, 500),
      durationMs: Date.now() - triggerStartMs,
    }).catch(err => console.warn("[scheduled-jobs] Telegram notification failed:", err));

    if (broadcastFn) {
      broadcastFn({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary: result.slice(0, 300),
        savedTo: vaultSaved ? savePath : null,
        status: job.lastStatus,
        timestamp: Date.now(),
      });
    }

    return result;
  } catch (err) {
    job.lastRun = new Date().toISOString();
    job.lastResult = String(err);
    job.lastStatus = "error";
    await saveConfig();
    if (kbCreateFn) {
      try { await writeJobStatus(job.id, { lastRun: job.lastRun, status: "error", savedTo: null, error: String(err).slice(0, 300) }); } catch {}
    }
    await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 500), null, null);
    sendJobCompletionNotification({
      jobId: job.id,
      jobName: job.name,
      status: "error",
      summary: String(err).slice(0, 500),
    }).catch(e => console.warn("[scheduled-jobs] Telegram error notification failed:", e));
    if (broadcastFn) {
      broadcastFn({
        type: "job_complete", jobId: job.id, jobName: job.name,
        summary: String(err).slice(0, 200), savedTo: null, status: "error", timestamp: Date.now(),
      });
    }
    throw err;
  } finally {
    jobRunning = false;
    currentRunningJobId = null;
  }
}
