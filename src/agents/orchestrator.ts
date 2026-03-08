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

  const filteredTools = opts.allTools.filter(t => agent.tools.includes(t.name));
  const anthropicTools = convertToolsToAnthropicFormat(filteredTools);
  const toolsUsed: string[] = [];

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
      max_tokens: 4096,
      system: agent.systemPrompt,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      messages,
    });

    totalInput += apiResponse.usage?.input_tokens || 0;
    totalOutput += apiResponse.usage?.output_tokens || 0;

    const textBlocks = apiResponse.content.filter(b => b.type === "text");
    const toolBlocks = apiResponse.content.filter(b => b.type === "tool_use") as Anthropic.ToolUseBlock[];

    if (textBlocks.length > 0) {
      finalResponse = textBlocks.map(b => (b as Anthropic.TextBlock).text).join("\n");
    }

    if (apiResponse.stop_reason === "end_turn" || toolBlocks.length === 0) {
      break;
    }

    messages.push({ role: "assistant", content: apiResponse.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
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

    messages.push({ role: "user", content: toolResults });
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
