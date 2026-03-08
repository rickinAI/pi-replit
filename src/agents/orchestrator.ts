import Anthropic from "@anthropic-ai/sdk";
import { getAgent } from "./loader.js";
import type { AgentConfig } from "./loader.js";

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
}

const MAX_TOOL_ITERATIONS = 15;

const NATIVE_WEB_SEARCH = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 10,
  user_location: {
    type: "approximate" as const,
    city: "Upper Saddle River",
    region: "New Jersey",
    country: "US",
    timezone: "America/New_York",
  },
};

const NATIVE_WEB_FETCH = {
  type: "web_fetch_20260209",
  name: "web_fetch",
  max_uses: 5,
};

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

export async function runSubAgent(opts: {
  agentId: string;
  task: string;
  context?: string;
  allTools: ToolImpl[];
  apiKey: string;
  model?: string;
}): Promise<SubAgentResult> {
  if (!opts.apiKey) throw new Error("Anthropic API key is not configured — cannot run sub-agents");
  const agent = getAgent(opts.agentId);
  if (!agent) throw new Error(`Agent "${opts.agentId}" not found. Use list_agents to see available agents.`);
  if (!agent.enabled) throw new Error(`Agent "${opts.agentId}" is currently disabled`);

  const startTime = Date.now();
  console.log(`[agent:${agent.id}] started — "${opts.task.slice(0, 80)}"`);

  const filteredTools = opts.allTools.filter(t => agent.tools.includes(t.name) && t.name !== "web_search" && t.name !== "web_fetch");
  const anthropicTools = convertToolsToAnthropicFormat(filteredTools);
  const toolsUsed: string[] = [];

  const allTools: any[] = [...anthropicTools, NATIVE_WEB_SEARCH, NATIVE_WEB_FETCH];

  const client = new Anthropic({ apiKey: opts.apiKey });
  const modelId = agent.model === "default" ? (opts.model || "claude-opus-4-6") : agent.model;

  let userContent = opts.task;
  if (opts.context) userContent = `Context:\n${opts.context}\n\nTask:\n${opts.task}`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent },
  ];

  let totalInput = 0;
  let totalOutput = 0;
  let finalResponse = "";

  const timeoutMs = agent.timeout * 1000;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    if (Date.now() - startTime > timeoutMs) {
      console.warn(`[agent:${agent.id}] timeout after ${agent.timeout}s`);
      break;
    }

    const apiResponse = await client.messages.create({
      model: modelId,
      max_tokens: 16384,
      system: agent.systemPrompt,
      tools: allTools,
      messages,
    });

    totalInput += apiResponse.usage?.input_tokens || 0;
    totalOutput += apiResponse.usage?.output_tokens || 0;

    const textBlocks = apiResponse.content.filter((b: any) => b.type === "text");
    const customToolBlocks = apiResponse.content.filter((b: any) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    const serverToolBlocks = apiResponse.content.filter((b: any) => b.type === "server_tool_use");

    if (textBlocks.length > 0) {
      finalResponse = textBlocks.map((b: any) => (b as Anthropic.TextBlock).text).join("\n");
    }

    for (const stb of serverToolBlocks) {
      const name = (stb as any).name || "web_search";
      if (!toolsUsed.includes(name)) toolsUsed.push(name);
      console.log(`[agent:${agent.id}] server tool: ${name}`);
    }

    if (apiResponse.stop_reason === "end_turn" || customToolBlocks.length === 0) {
      break;
    }

    messages.push({ role: "assistant", content: apiResponse.content as any });

    const userContent: any[] = [];

    for (const toolCall of customToolBlocks) {
      const impl = filteredTools.find(t => t.name === toolCall.name);
      if (!impl) {
        userContent.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: `Tool "${toolCall.name}" not available`,
          is_error: true,
        });
        continue;
      }

      if (!toolsUsed.includes(toolCall.name)) toolsUsed.push(toolCall.name);
      console.log(`[agent:${agent.id}] calling tool: ${toolCall.name}`);

      try {
        const result = await impl.execute(toolCall.id, toolCall.input);
        const text = result.content
          .map(c => c.text || JSON.stringify(c))
          .filter(Boolean)
          .join("\n");
        userContent.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: text || "(empty result)",
        });
      } catch (err: any) {
        userContent.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: `Error: ${err.message}`,
          is_error: true,
        });
      }
    }

    if (userContent.length > 0) {
      messages.push({ role: "user", content: userContent });
    }
  }

  if (!finalResponse && messages.length > 1) {
    try {
      console.log(`[agent:${agent.id}] no final response — requesting summary`);
      messages.push({ role: "user", content: "Please provide your final summary and findings based on the work you've done so far." });
      const summaryResponse = await client.messages.create({
        model: modelId,
        max_tokens: 4096,
        system: agent.systemPrompt,
        messages,
      });
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

  return {
    agentId: agent.id,
    agentName: agent.name,
    response: finalResponse || "(No response generated)",
    toolsUsed,
    durationMs,
    tokensUsed: { input: totalInput, output: totalOutput },
  };
}
