import { getPool } from "./db.js";
import { getDarkNodeEmails, markDarkNodeProcessed } from "./gmail.js";

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

type RunAgentFn = (agentId: string, task: string) => Promise<{ response: string; timedOut: boolean }>;
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
    prompt: `Compile a comprehensive daily intelligence brief covering 5 categories. For each item, tag relevance: 🔴 High (directly impacts Moody's Banking), 🟡 Medium (industry trend worth watching), 🟢 Low (background context). Include source URLs for every item.

CATEGORY 1 — Moody's Corporate News:
Search site:moodys.com and news for "Moody's" for any press releases, product announcements, leadership changes, earnings, or strategic moves. Focus on Banking Solutions, Lending, KYC, Risk Analytics, and data products.
Also search X: x_search("from:MoodysAnalytics OR from:MoodysInvSvc OR from:Moodys") and x_search("Moody's Banking OR Credit Lens OR Moody's Analytics") for real-time announcements.

CATEGORY 2 — Banking Segment Specifics:
Search for news about Moody's banking products: Credit Lens, Moody's Analytics banking, OnlineALM, Orbis, BvD. Include customer wins, partnerships, or product launches in the banking vertical.

CATEGORY 3 — Competitor Intelligence:
Search for latest news from ALL of these competitors using BOTH web_search AND x_search:

Credit Rating & Data Peers:
- Bloomberg — Bloomberg Data, Enterprise Data, AI initiatives
- S&P Global — Market Intelligence, Capital IQ, data strategy
- Fitch — Fitch Ratings, Fitch Solutions, banking analytics, data products
- Nasdaq — Nasdaq Financial Technology, AxiomSL, Calypso, risk/regulatory tech
X search: x_search("Bloomberg data AI OR S&P Global Capital IQ OR Fitch Solutions OR Nasdaq AxiomSL")

Banking Tech / Lending Platforms:
- nCino — Bank operating system, lending automation, AI in banking
- QRM — Credit risk, ALM, FTP, balance sheet management (direct Credit Lens competitor)
- Empyrean (Emperion) — Lending technology, credit decisioning, banking analytics
X search: x_search("nCino OR QRM credit risk OR Empyrean lending")

Data & AI Infrastructure:
- Quantexa — Entity resolution, knowledge graph, agentic AI, banking deals
- Databricks — Financial services, lakehouse for banking, Delta Sharing
X search: x_search("Quantexa banking OR Databricks financial services")

Regulatory & Compliance Partners:
- Regnology — Regulatory reporting tech
- FinregE — Regulatory intelligence automation
- ValidMind — Model risk management, AI governance
X search: x_search("Regnology OR FinregE OR ValidMind AI governance")

CATEGORY 4 — Enterprise AI Trends:
Search for: agentic AI in banking/financial services, enterprise LLM deployments in regulated industries, AI governance and regulation (EU AI Act, US banking regulators), MCP (Model Context Protocol) enterprise adoption, CDM/data standards in financial services.
Also search X: x_search("agentic AI banking OR enterprise LLM financial services OR AI governance banking") for cutting-edge discussions and announcements.

CATEGORY 5 — Industry Analyst Coverage:
Search site:celent.com for mentions of Moody's, Credit Lens, lending tech, risk analytics, ALM, banking AI, and competitors.
Search site:chartis-research.com for RiskTech100, quadrant reports, credit risk, market risk, model risk, RegTech rankings.
Search for reports from Forrester, Gartner, and IDC on banking technology, risk analytics, or enterprise AI in financial services.
Also search X: x_search("from:CelentResearch OR from:Chartis_Research OR Celent banking OR RiskTech100") for analyst commentary and early report previews.

OUTPUT FORMAT — Save using notes_create to "Scheduled Reports/Moody's Intelligence/Daily/{today's date YYYY-MM-DD}-Brief.md":

# Moody's Intelligence Brief — {today's date}

## 🏢 Moody's Corporate
- {bullet summaries with source URLs and relevance tags}

## 🏦 Banking Segment
- {bullet summaries with source URLs and relevance tags}

## 🔍 Competitor Watch
### Credit Rating & Data Peers
#### Bloomberg
#### S&P Global
#### Fitch
#### Nasdaq
### Banking Tech & Lending
#### nCino
#### QRM
#### Empyrean
### Data & AI Infrastructure
#### Quantexa
#### Databricks
### Regulatory & Compliance
#### Regnology / FinregE / ValidMind
- {bullet summaries with source URLs and relevance tags}

## 🤖 Enterprise AI Trends
- {bullet summaries with source URLs and relevance tags}

## 📊 Industry Analyst Coverage
### Celent
### Chartis Research
### Other Analysts (Forrester / Gartner / IDC)
- {bullet summaries with source URLs and relevance tags}

## 🐦 X/Twitter Signals
- {notable tweets from competitors, analysts, or industry leaders that don't fit the categories above}
- {early signals, hot takes, or viral threads relevant to Moody's positioning}
- {include tweet author, handle, and URL for each}

## ⚡ Key Takeaways
- {3-5 bullet executive summary of what matters most for Moody's Banking Solutions positioning}

If a search returns no new results for a category, note "No new developments" rather than omitting the section.

Do NOT update competitor or analyst profiles in this pass — a separate scheduled job handles that.`,
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
    enabled: true,
  },
  {
    id: "darknode-inbox-monitor",
    name: "Inbox Monitor (@darknode)",
    agentId: "orchestrator",
    prompt: "",
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 30 },
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
let runAgentFn: RunAgentFn | null = null;
let broadcastFn: BroadcastFn | null = null;
let kbCreateFn: KbCreateFn | null = null;
let kbListFn: KbListFn | null = null;
let kbMoveFn: KbMoveFn | null = null;

async function archiveOldReports(): Promise<void> {
  if (!kbListFn || !kbMoveFn) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const folders = [
    { src: "Scheduled Reports/Moody's Intelligence/Daily", dest: "Archive/Moody's Intelligence/Daily" },
    { src: "Scheduled Reports/Moody's Intelligence/Weekly", dest: "Archive/Moody's Intelligence/Weekly" },
    { src: "Scheduled Reports/Real Estate", dest: "Archive/Real Estate" },
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
      if (scanJob && (scanJob.prompt.includes("minPrice=1500000") || scanJob.prompt.includes("$1.5M–$2M") || scanJob.prompt.includes("minBeds=5"))) {
        const preset = DEFAULT_JOBS.find(j => j.id === "real-estate-daily-scan")!;
        scanJob.prompt = preset.prompt;
        console.log("[scheduled-jobs] Migrated real-estate-daily-scan: updated budget to $1.3M–$1.8M, 4+ bed, added commute/market-overview steps");
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

  if (kbCreateFn) {
    const todayKey = getTodayKey();
    const timestamp = new Date().toLocaleString("en-US", { timeZone: config.timezone }).replace(/[/:]/g, "-").replace(/,\s*/g, "_");
    const savePath = `Scheduled Reports/Inbox Monitor/${todayKey}-${timestamp}.md`;
    try {
      await kbCreateFn(savePath, `# Inbox Monitor Results\n*Processed: ${new Date().toLocaleString("en-US", { timeZone: config.timezone })}*\n*Emails processed: ${emails.length}*\n\n${fullResult}`);
    } catch {}
    try {
      await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus!, savedTo: savePath, error: null });
    } catch {}
  }

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

async function checkJobs(): Promise<void> {
  if (jobRunning || !runAgentFn) return;

  const now = getNow();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayKey = getTodayKey();
  const dayOfWeek = now.getDay();

  for (const job of config.jobs) {
    if (!job.enabled) continue;
    if (!shouldJobRun(job, now, nowMinutes, todayKey, dayOfWeek)) continue;

    if (job.schedule.type !== "interval") {
      const runKey = `${job.id}_${todayKey}`;
      config.lastJobRun[runKey] = true;
      await saveConfig();
    }

    jobRunning = true;
    console.log(`[scheduled-jobs] Running job: ${job.name} (${job.id})`);

    try {
      if (job.id === "darknode-inbox-monitor") {
        await runInboxMonitor(job);
      } else {
        const agentResult = await runAgentFn(job.agentId, job.prompt);
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
            summary: result.slice(0, 200),
            timestamp: Date.now(),
          });
        }

        console.log(`[scheduled-jobs] Job completed${isPartial ? " (partial)" : ""}: ${job.name}`);

        if ((job.id.startsWith("moodys") || job.id.startsWith("real-estate")) && kbListFn && kbMoveFn) {
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
      console.error(`[scheduled-jobs] Job failed: ${job.name}`, err);
    } finally {
      jobRunning = false;
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
): void {
  runAgentFn = runAgent;
  broadcastFn = broadcast;
  kbCreateFn = kbCreate || null;
  kbListFn = kbList || null;
  kbMoveFn = kbMove || null;

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
  console.log(`[scheduled-jobs] Manual trigger: ${job.name}`);

  try {
    if (job.id === "darknode-inbox-monitor") {
      await runInboxMonitor(job);
      return job.lastResult || "Inbox monitor completed";
    }

    const agentResult = await runAgentFn(job.agentId, job.prompt);
    const result = agentResult.response;
    const isPartial = agentResult.timedOut || result.includes("⚠️ PARTIAL");
    job.lastRun = new Date().toISOString();
    job.lastResult = result.slice(0, 500);
    job.lastStatus = isPartial ? "partial" : "success";
    await saveConfig();

    const todayKey = getTodayKey();
    const safeName = job.name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-");
    const savePath = getJobSavePath(job.id, todayKey, safeName);
    let vaultSaved = false;
    if (kbCreateFn) {
      try {
        await kbCreateFn(savePath, `# ${job.name}\n*Generated: ${new Date().toLocaleString("en-US", { timeZone: config.timezone })}*\n\n${result}`);
        vaultSaved = true;
      } catch {}
      try { await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus!, savedTo: vaultSaved ? savePath : null, error: vaultSaved ? null : "vault save failed" }); } catch {}
    }

    if ((job.id.startsWith("moodys") || job.id.startsWith("real-estate")) && kbListFn && kbMoveFn) {
      await archiveOldReports();
    }

    if (broadcastFn) {
      broadcastFn({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary: result.slice(0, 200),
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
    throw err;
  } finally {
    jobRunning = false;
  }
}
