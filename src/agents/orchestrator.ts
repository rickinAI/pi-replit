import Anthropic from "@anthropic-ai/sdk";
import { getAgent } from "./loader.js";
import type { AgentConfig } from "./loader.js";
import { getVaultSkillsContext, hasVaultTools } from "../obsidian-skills.js";

interface ToolImpl {
  name: string;
  description: string;
  parameters: any;
  execute: (toolCallId: string, params: any) => Promise<{ content: { type: string; text: string }[]; details: any }>;
}

export interface SubAgentResult {
  agentId: string;
  agentName: string;
  response: string;
  toolsUsed: string[];
  durationMs: number;
  tokensUsed: { input: number; output: number };
  modelUsed: string;
  timedOut: boolean;
  error?: string;
}

const MAX_TOOL_ITERATIONS = 15;

function convertToolsToAnthropicFormat(tools: ToolImpl[]): Anthropic.Tool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: toJsonSchema(t.parameters) as Anthropic.Tool.InputSchema,
  }));
}

function toJsonSchema(typeboxSchema: any): any {
  if (!typeboxSchema) return { type: "object", properties: {} };
  const schema = JSON.parse(JSON.stringify(typeboxSchema));
  delete schema[Symbol.for("TypeBox.Kind")];
  removeTypeBoxKeys(schema);
  return schema;
}

function removeTypeBoxKeys(obj: any): void {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith("$") && key !== "$ref" && key !== "$defs") {
      delete obj[key];
    }
    removeTypeBoxKeys(obj[key]);
  }
}

function parseApiError(err: any): { status: number; type: string; message: string } {
  const status = err?.status || err?.statusCode || 0;
  let type = "unknown_error";
  let message = err?.message || String(err);
  try {
    const body = err?.error || err?.body;
    if (body?.error) {
      type = body.error.type || type;
      message = body.error.message || message;
    }
  } catch {}
  return { status, type, message };
}

export async function runSubAgent(opts: {
  agentId: string;
  task: string;
  context?: string;
  allTools: ToolImpl[];
  apiKey: string;
  model?: string;
  onProgress?: (info: { toolName: string; iteration: number }) => void;
}): Promise<SubAgentResult> {
  if (!opts.apiKey) throw new Error("Anthropic API key is not configured — cannot run sub-agents");
  const agent = getAgent(opts.agentId);
  if (!agent) throw new Error(`Agent "${opts.agentId}" not found. Use list_agents to see available agents.`);
  if (!agent.enabled) throw new Error(`Agent "${opts.agentId}" is currently disabled`);

  const startTime = Date.now();
  console.log(`[agent:${agent.id}] started — "${opts.task.slice(0, 80)}"`);

  const filteredTools = opts.allTools.filter(t => agent.tools.includes(t.name));
  console.log(`[agent:${agent.id}] tools: ${filteredTools.length} of ${opts.allTools.length} (${filteredTools.map(t => t.name).join(", ")})`);
  const anthropicTools = convertToolsToAnthropicFormat(filteredTools);
  const toolsUsed: string[] = [];

  const client = new Anthropic({ apiKey: opts.apiKey });
  const modelId = agent.model === "default" ? (opts.model || "claude-sonnet-4-6") : agent.model;

  let systemPrompt = agent.systemPrompt;
  if (hasVaultTools(agent.tools)) {
    try {
      const vaultSkills = await getVaultSkillsContext();
      if (vaultSkills) {
        systemPrompt += vaultSkills;
        console.log(`[agent:${agent.id}] injected Obsidian vault skills into system prompt`);
      }
    } catch (err: any) {
      console.warn(`[agent:${agent.id}] failed to load vault skills: ${err.message}`);
    }
  }

  let userContent = opts.task;
  if (opts.context) userContent = `Context:\n${opts.context}\n\nTask:\n${opts.task}`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent },
  ];

  let totalInput = 0;
  let totalOutput = 0;
  let finalResponse = "";
  let softTimeoutSent = false;
  let hardTimedOut = false;
  let containerId: string | undefined;

  const timeoutMs = agent.timeout * 1000;
  const softTimeoutMs = timeoutMs * 0.8;

  const buildResult = (extra?: { error?: string }): SubAgentResult => ({
    agentId: agent.id,
    agentName: agent.name,
    response: finalResponse || "(No response generated)",
    toolsUsed,
    durationMs: Date.now() - startTime,
    tokensUsed: { input: totalInput, output: totalOutput },
    modelUsed: modelId,
    timedOut: hardTimedOut,
    ...(extra || {}),
  });

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const elapsed = Date.now() - startTime;

    if (elapsed > timeoutMs) {
      console.warn(`[agent:${agent.id}] timeout after ${agent.timeout}s`);
      hardTimedOut = true;
      break;
    }

    if (!softTimeoutSent && elapsed > softTimeoutMs) {
      softTimeoutSent = true;
      console.log(`[agent:${agent.id}] soft timeout at 80% — nudging to save`);
      messages.push({
        role: "user",
        content: "⚠️ TIME WARNING: You are running low on time. Immediately save whatever findings you have so far using notes_create. Prefix the filename with '⚠️ PARTIAL — ' to indicate incomplete results. Then provide your final summary.",
      });
    }

    let apiResponse: Anthropic.Message;
    try {
      const requestParams: any = {
        model: modelId,
        max_tokens: 16384,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      };
      if (containerId) {
        requestParams.container_id = containerId;
      }
      apiResponse = await client.messages.create(requestParams);
    } catch (err: any) {
      const parsed = parseApiError(err);
      console.error(`[agent:${agent.id}] API error (${parsed.status}): ${parsed.type} — ${parsed.message}`);

      if (parsed.status === 400) {
        if (containerId && parsed.message.includes("container")) {
          console.warn(`[agent:${agent.id}] stale container_id — clearing and retrying`);
          containerId = undefined;
          try {
            apiResponse = await client.messages.create({
              model: modelId,
              max_tokens: 16384,
              system: systemPrompt,
              tools: anthropicTools,
              messages,
            });
          } catch (retryErr: any) {
            const retryParsed = parseApiError(retryErr);
            console.error(`[agent:${agent.id}] retry without container_id also failed: ${retryParsed.message}`);
            finalResponse = finalResponse
              ? `${finalResponse}\n\n[Agent hit API error: ${retryParsed.message}]`
              : `Agent "${agent.id}" encountered an API error: ${retryParsed.message}`;
            return buildResult({ error: retryParsed.message });
          }
        } else {
          finalResponse = finalResponse
            ? `${finalResponse}\n\n[Agent hit API error: ${parsed.message}]`
            : `Agent "${agent.id}" encountered an API error on iteration ${iteration + 1}: ${parsed.message}`;
          return buildResult({ error: parsed.message });
        }
      }

      if (parsed.status === 429 || parsed.status === 529) {
        console.log(`[agent:${agent.id}] rate limited — waiting 5s before retry`);
        await new Promise(r => setTimeout(r, 5000));
        try {
          const retryParams: any = {
            model: modelId,
            max_tokens: 16384,
            system: systemPrompt,
            tools: anthropicTools,
            messages,
          };
          if (containerId) retryParams.container_id = containerId;
          apiResponse = await client.messages.create(retryParams);
        } catch (retryErr: any) {
          const retryParsed = parseApiError(retryErr);
          console.error(`[agent:${agent.id}] retry also failed (${retryParsed.status}): ${retryParsed.message}`);
          finalResponse = finalResponse
            ? `${finalResponse}\n\n[Agent hit API error after retry: ${retryParsed.message}]`
            : `Agent "${agent.id}" failed after retry: ${retryParsed.message}`;
          return buildResult({ error: retryParsed.message });
        }
      } else {
        finalResponse = finalResponse
          ? `${finalResponse}\n\n[Agent hit API error: ${parsed.message}]`
          : `Agent "${agent.id}" encountered an API error: ${parsed.message}`;
        return buildResult({ error: parsed.message });
      }
    }

    if ((apiResponse as any).container_id) {
      containerId = (apiResponse as any).container_id;
    }

    totalInput += apiResponse!.usage?.input_tokens || 0;
    totalOutput += apiResponse!.usage?.output_tokens || 0;

    const textBlocks = apiResponse!.content.filter((b: any) => b.type === "text");
    const toolBlocks = apiResponse!.content.filter((b: any) => b.type === "tool_use") as Anthropic.ToolUseBlock[];

    if (textBlocks.length > 0) {
      finalResponse = textBlocks.map((b: any) => (b as Anthropic.TextBlock).text).join("\n");
    }

    if (apiResponse!.stop_reason === "end_turn" || toolBlocks.length === 0) {
      break;
    }

    messages.push({ role: "assistant", content: apiResponse!.content as any });

    const toolResults: any[] = [];

    for (const toolCall of toolBlocks) {
      const impl = filteredTools.find(t => t.name === toolCall.name);
      if (!impl) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: `Tool "${toolCall.name}" not available`,
          is_error: true,
        });
        continue;
      }

      if (!toolsUsed.includes(toolCall.name)) toolsUsed.push(toolCall.name);
      console.log(`[agent:${agent.id}] calling tool: ${toolCall.name}`);
      if (opts.onProgress) {
        try { opts.onProgress({ toolName: toolCall.name, iteration }); } catch {}
      }

      try {
        const result = await impl.execute(toolCall.id, toolCall.input);
        const text = result.content
          .map(c => c.text || JSON.stringify(c))
          .filter(Boolean)
          .join("\n");
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: text || "(empty result)",
        });
      } catch (err: any) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: `Error: ${err.message}`,
          is_error: true,
        });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }

  if (!finalResponse && messages.length > 1 && !hardTimedOut) {
    try {
      console.log(`[agent:${agent.id}] no final response — requesting summary`);
      messages.push({ role: "user", content: "Please provide your final summary and findings based on the work you've done so far." });
      const summaryParams: any = {
        model: modelId,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      };
      if (containerId) summaryParams.container_id = containerId;
      const summaryResponse = await client.messages.create(summaryParams);
      totalInput += summaryResponse.usage?.input_tokens || 0;
      totalOutput += summaryResponse.usage?.output_tokens || 0;
      const summaryText = summaryResponse.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => (b as Anthropic.TextBlock).text)
        .join("\n");
      if (summaryText) finalResponse = summaryText;
    } catch (err: any) {
      console.error(`[agent:${agent.id}] summary request failed:`, err.message);
    }
  }

  const durationMs = Date.now() - startTime;
  console.log(`[agent:${agent.id}] completed in ${(durationMs / 1000).toFixed(1)}s (${toolsUsed.length} tools used, ${totalInput + totalOutput} tokens)`);

  return buildResult();
}
