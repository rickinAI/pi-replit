import fs from "fs";
import path from "path";

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  enabled: boolean;
  timeout: number;
  model: string;
}

let agents: AgentConfig[] = [];
let configPath = "";
let registeredToolNames: Set<string> | null = null;

export function init(dataDir: string): void {
  configPath = path.join(dataDir, "agents.json");
  loadAgents();

  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    fs.watch(configPath, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log("[agents] Config file changed — reloading");
        loadAgents();
        reloadTimer = null;
      }, 500);
    });
  } catch {
    console.warn("[agents] Could not watch agents.json — using periodic reload");
    setInterval(loadAgents, 60_000);
  }
}

export function setRegisteredTools(toolNames: string[]): void {
  registeredToolNames = new Set(toolNames);
  validateAgentTools();
}

function validateAgentTools(): void {
  if (!registeredToolNames || agents.length === 0) return;
  for (const agent of agents) {
    const unknownTools = agent.tools.filter(t => !registeredToolNames!.has(t));
    if (unknownTools.length > 0) {
      console.warn(`[agents] WARNING: agent "${agent.id}" references unknown tools: ${unknownTools.join(", ")}`);
    }
  }
}

function loadAgents(): void {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error("[agents] agents.json must be an array");
      return;
    }
    const valid: AgentConfig[] = [];
    for (const entry of parsed) {
      if (!entry.id || !entry.name || !entry.systemPrompt || !Array.isArray(entry.tools)) {
        console.warn(`[agents] Skipping malformed agent entry: ${JSON.stringify(entry.id || entry.name || "unknown")}`);
        continue;
      }
      valid.push({
        id: entry.id,
        name: entry.name,
        description: entry.description || "",
        systemPrompt: entry.systemPrompt,
        tools: entry.tools,
        enabled: entry.enabled !== false,
        timeout: entry.timeout || 120,
        model: entry.model || "default",
      });
    }
    agents = valid;
    console.log(`[agents] Loaded ${agents.length} agents: ${agents.map(a => a.id).join(", ")}`);
    if (registeredToolNames) validateAgentTools();
  } catch (err: any) {
    console.error(`[agents] Failed to load agents.json: ${err.message}`);
  }
}

export function getAgents(): AgentConfig[] {
  return agents;
}

export function getEnabledAgents(): AgentConfig[] {
  return agents.filter(a => a.enabled);
}

export function getAgent(id: string): AgentConfig | undefined {
  return agents.find(a => a.id === id);
}
