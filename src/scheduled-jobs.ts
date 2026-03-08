import { getPool } from "./db.js";

export interface ScheduledJob {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  schedule: {
    type: "daily" | "weekly";
    hour: number;
    minute: number;
    daysOfWeek?: number[];
  };
  enabled: boolean;
  lastRun?: string;
  lastResult?: string;
  lastStatus?: "success" | "error";
}

interface ScheduledJobsConfig {
  jobs: ScheduledJob[];
  lastJobRun: Record<string, boolean>;
  timezone: string;
}

type RunAgentFn = (agentId: string, task: string) => Promise<string>;
type BroadcastFn = (event: any) => void;
type KbCreateFn = (path: string, content: string) => Promise<any>;

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
2. Note any significant moves (>2%) with brief analysis
3. Summarize overall market sentiment
4. Flag any notable earnings or economic events today

Save the report to "Scheduled Reports/Market Summary.md" (overwrite previous).`,
    schedule: { type: "daily", hour: 7, minute: 30 },
    enabled: false,
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

async function checkJobs(): Promise<void> {
  if (jobRunning || !runAgentFn) return;

  const now = getNow();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayKey = getTodayKey();
  const dayOfWeek = now.getDay();

  for (const job of config.jobs) {
    if (!job.enabled) continue;

    const targetMinutes = job.schedule.hour * 60 + job.schedule.minute;
    if (nowMinutes < targetMinutes || nowMinutes > targetMinutes + 2) continue;

    if (job.schedule.type === "weekly" && job.schedule.daysOfWeek) {
      if (!job.schedule.daysOfWeek.includes(dayOfWeek)) continue;
    }

    const runKey = `${job.id}_${todayKey}`;
    if (config.lastJobRun[runKey]) continue;

    config.lastJobRun[runKey] = true;
    await saveConfig();

    jobRunning = true;
    console.log(`[scheduled-jobs] Running job: ${job.name} (${job.id})`);

    try {
      const result = await runAgentFn(job.agentId, job.prompt);
      job.lastRun = new Date().toISOString();
      job.lastResult = result.slice(0, 500);
      job.lastStatus = "success";
      await saveConfig();

      const dateStr = todayKey;
      const safeName = job.name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-");
      if (kbCreateFn) {
        try {
          await kbCreateFn(`Scheduled Reports/${dateStr}-${safeName}.md`, `# ${job.name}\n*Generated: ${new Date().toLocaleString("en-US", { timeZone: config.timezone })}*\n\n${result}`);
        } catch (e) {
          console.error(`[scheduled-jobs] Failed to save to vault:`, e);
        }
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

      console.log(`[scheduled-jobs] Job completed: ${job.name}`);
    } catch (err) {
      job.lastRun = new Date().toISOString();
      job.lastResult = String(err);
      job.lastStatus = "error";
      await saveConfig();
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
): void {
  runAgentFn = runAgent;
  broadcastFn = broadcast;
  kbCreateFn = kbCreate || null;

  checkInterval = setInterval(() => {
    checkJobs().catch(err => console.error("[scheduled-jobs] Check error:", err));
  }, 60_000);

  const enabledJobs = config.jobs.filter(j => j.enabled);
  const jobList = enabledJobs.length > 0
    ? enabledJobs.map(j => `${j.name}/${j.schedule.hour}:${String(j.schedule.minute).padStart(2, "0")}`).join(", ")
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
    const result = await runAgentFn(job.agentId, job.prompt);
    job.lastRun = new Date().toISOString();
    job.lastResult = result.slice(0, 500);
    job.lastStatus = "success";
    await saveConfig();

    const todayKey = getTodayKey();
    const safeName = job.name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-");
    if (kbCreateFn) {
      try {
        await kbCreateFn(`Scheduled Reports/${todayKey}-${safeName}.md`, `# ${job.name}\n*Generated: ${new Date().toLocaleString("en-US", { timeZone: config.timezone })}*\n\n${result}`);
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

    return result;
  } catch (err) {
    job.lastRun = new Date().toISOString();
    job.lastResult = String(err);
    job.lastStatus = "error";
    await saveConfig();
    throw err;
  } finally {
    jobRunning = false;
  }
}
