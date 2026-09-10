import { Logger } from '@nestjs/common';
import type { LlmService } from '../llm/llm.service';
import type { LlmMessage, LlmTool } from '../llm/llm.types';
import type { ModelChoice } from './agent.config';

/**
 * What running a tool produced. `done: true` ends the loop — the tools that
 * submit a finished draft or review use it to signal "this is the answer",
 * which is why neither pass needs a separate closing call.
 */
export interface ToolOutcome {
  done: boolean;
  result: string;
}

export interface AgentTool {
  spec: LlmTool;
  execute(args: Record<string, unknown>): Promise<ToolOutcome> | ToolOutcome;
}

export interface PassOptions {
  model: ModelChoice;
  system: string;
  messages: LlmMessage[];
  tools: AgentTool[];
  /** Guards against a model that calls tools forever without finishing. */
  maxSteps: number;
  usage: { inputTokens: number; outputTokens: number };
  label: string;
}

const logger = new Logger('ToolLoop');

/**
 * The single agent loop both passes run on: call the model, run whatever tools
 * it asks for, hand the results back, repeat until a tool signals completion.
 *
 * Returns whether a tool ended it — a pass that runs out of steps without
 * submitting anything is a failure the caller has to account for, not an
 * answer.
 */
export async function runPass(
  llm: LlmService,
  options: PassOptions,
): Promise<boolean> {
  const { model, tools, usage, label } = options;
  const messages = [...options.messages];
  const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));

  for (let step = 0; step < options.maxSteps; step++) {
    const response = await llm.generate({
      provider: model.provider,
      model: model.model,
      system: options.system,
      messages,
      tools: tools.map((tool) => tool.spec),
      temperature: 0.2,
    });
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;

    if (response.toolCalls.length === 0) {
      logger.warn(`${label}: answered without calling a tool`);
      return false;
    }

    messages.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    let done = false;
    for (const call of response.toolCalls) {
      const tool = byName.get(call.name);
      // Every call in the turn is answered even after one finishes: providers
      // reject a follow-up whose tool calls are missing their results.
      const outcome = tool
        ? await run(tool, call.args, label)
        : { done: false, result: `Unknown tool "${call.name}".` };
      done ||= outcome.done;
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: outcome.result,
      });
    }

    if (done) {
      return true;
    }
  }

  logger.warn(`${label}: hit the ${options.maxSteps}-step limit`);
  return false;
}

/**
 * A tool that throws is reported back to the model rather than killing the run:
 * a timed-out lookup should cost the agent that one fact, not the listing.
 */
async function run(
  tool: AgentTool,
  args: Record<string, unknown>,
  label: string,
): Promise<ToolOutcome> {
  try {
    return await tool.execute(args);
  } catch (error) {
    const message = (error as Error).message;
    logger.warn(`${label}: ${tool.spec.name} failed — ${message}`);
    return { done: false, result: `Tool failed: ${message}` };
  }
}
