import { Logger } from '@nestjs/common';
import {
  Agent,
  MaxTurnsExceededError,
  RunContext as SdkRunContext,
  run,
  type AgentInputItem,
  type FunctionTool,
} from '@openai/agents';
import type { z } from 'zod';
import type { LlmMessage, LlmReasoningEffort } from '../llm/llm.types';
import type { AgentStage, RunContext } from './types';

export interface PassOptions<T extends z.ZodType> {
  /** Which OpenAI model runs this pass. */
  model: string;
  system: string;
  messages: LlmMessage[];
  /** What the pass returns. The SDK sends it as the response format on every turn and validates the answer against it. */
  outputType: T;
  tools?: FunctionTool<RunContext, any, any>[];
  /** Guards against a model that calls tools forever without answering. */
  maxSteps: number;
  /** Reasoning effort for every turn of the pass. */
  reasoningEffort: LlmReasoningEffort;
  /** The per-listing state the tools read and write. */
  context: RunContext;
  label: string;
  stage: AgentStage;
}

const logger = new Logger('AgentRunner');

/**
 * The single agent pass both halves of the run use, on the Agents SDK's loop.
 *
 * The model calls tools until it is ready, then answers; the answer is the
 * pass's result, already validated against `outputType`. Every turn is held to
 * that format, so a turn is either tool calls or the finished answer.
 *
 * Returns null when the pass runs out of turns without answering. An answer
 * that fails the schema, or a refusal, throws for the caller to log. Either way
 * the tokens it cost are counted.
 */
export async function runPass<T extends z.ZodType>(
  options: PassOptions<T>,
): Promise<z.infer<T> | null> {
  const { context, label, stage } = options;
  context.activeStage = stage;
  context.stats[stage].model = options.model;
  const started = Date.now();
  const elapsed = () => `${Date.now() - started}ms`;
  logger.log(`${label}: started on ${options.model}`);

  const agent = new Agent<RunContext, T>({
    name: label,
    model: options.model,
    instructions: options.system,
    outputType: options.outputType,
    tools: options.tools ?? [],
    modelSettings: { reasoning: { effort: options.reasoningEffort } },
  });

  // Wrapped here rather than letting `run()` wrap it, so the usage the SDK
  // accumulates is readable afterwards without reaching into run state.
  const wrapped = new SdkRunContext(context);
  let output: z.infer<T> | null = null;

  try {
    const result = await run(agent, toAgentInput(options.messages), {
      context: wrapped,
      maxTurns: options.maxSteps,
    });
    output = (result.finalOutput ?? null) as z.infer<T> | null;
    if (output === null) {
      logger.error(`${label}: stopped after ${elapsed()} without an answer`);
    } else {
      logger.log(
        `${label}: completed in ${elapsed()} (${wrapped.usage.inputTokens} in / ${wrapped.usage.outputTokens} out tokens)`,
      );
    }
    return output;
  } catch (error) {
    if (error instanceof MaxTurnsExceededError) {
      logger.error(
        `${label}: hit the ${options.maxSteps}-turn limit after ${elapsed()} without answering`,
      );
      return null;
    }
    // Logged by the caller, which knows which pass of which listing broke.
    throw error;
  } finally {
    // A pass that fails cost tokens too.
    context.usage.inputTokens += wrapped.usage.inputTokens;
    context.usage.outputTokens += wrapped.usage.outputTokens;
    context.stats[stage].inputTokens += wrapped.usage.inputTokens;
    context.stats[stage].outputTokens += wrapped.usage.outputTokens;
    context.stats[stage].durationMs = Date.now() - started;
    context.stats[stage].completed = output !== null;
    context.activeStage = null;
  }
}

/** Our message shape to the SDK's input items. Only user turns start a pass. */
function toAgentInput(messages: LlmMessage[]): AgentInputItem[] {
  return messages.flatMap((message): AgentInputItem[] => {
    if (message.role !== 'user') {
      return [];
    }
    return [
      {
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) =>
                part.type === 'text'
                  ? { type: 'input_text' as const, text: part.text }
                  : { type: 'input_image' as const, image: part.url },
              ),
      },
    ];
  });
}
