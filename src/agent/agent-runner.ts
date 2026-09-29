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
import type { LlmMessage } from '../llm/llm.types';
import type { AgentStage, RunContext } from './types';

export interface PassOptions {
  /** Which OpenAI model runs this pass. */
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: FunctionTool<RunContext, any, any>[];
  /** Guards against a model that calls tools forever without finishing. */
  maxSteps: number;
  /** Sampling temperature for every turn of the pass. */
  temperature: number;
  /** The per-listing state the tools read and write. */
  context: RunContext;
  label: string;
  stage: AgentStage;
}

export interface StructuredPassOptions<T extends z.ZodType> {
  /** Which OpenAI model runs this pass. */
  model: string;
  system: string;
  messages: LlmMessage[];
  /** The one answer the pass returns; the SDK validates the model's output against it. */
  outputType: T;
  temperature: number;
  context: RunContext;
  label: string;
  stage: AgentStage;
}

const logger = new Logger('AgentRunner');

/** Adds the usage the SDK accumulated over a pass to the run and to its stage. */
function addPassUsage(
  context: RunContext,
  stage: AgentStage,
  usage: { inputTokens: number; outputTokens: number },
) {
  context.usage.inputTokens += usage.inputTokens;
  context.usage.outputTokens += usage.outputTokens;
  context.stats[stage].inputTokens += usage.inputTokens;
  context.stats[stage].outputTokens += usage.outputTokens;
}

/**
 * The single agent pass both halves of the run use, on the Agents SDK's loop.
 *
 * Returns whether a tool ended it — a pass that runs out of turns without
 * submitting anything is a failure the caller has to account for, not an
 * answer.
 */
export async function runPass(options: PassOptions): Promise<boolean> {
  const { context, label, stage } = options;
  context.finished = false;
  context.activeStage = stage;
  context.stats[stage].model = options.model;
  const started = Date.now();
  const elapsed = () => `${Date.now() - started}ms`;
  logger.log(`${label}: started on ${options.model}`);

  const agent = new Agent<RunContext>({
    name: label,
    model: options.model,
    instructions: options.system,
    tools: options.tools,
    modelSettings: { temperature: options.temperature },
    /**
     * The loop's real exit. `stopAtToolNames` would stop on any submit call,
     * including one rejected for the wrong shape, which has to go back to the
     * model for another attempt. Only the tools themselves know which it was,
     * so they set `context.finished` and this reads it, once per turn, after
     * every tool in that turn has run.
     */
    toolUseBehavior: () =>
      context.finished
        ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: 'done' }
        : { isFinalOutput: false, isInterrupted: undefined },
  });

  // Wrapped here rather than letting `run()` wrap it, so the usage the SDK
  // accumulates is readable afterwards without reaching into run state.
  const wrapped = new SdkRunContext(context);

  try {
    const result = await run(agent, toAgentInput(options.messages), {
      context: wrapped,
      maxTurns: options.maxSteps,
    });
    addPassUsage(context, stage, wrapped.usage);

    if (!context.finished) {
      // The model answered with prose instead of submitting. Every pass ends by
      // submitting, so there is nothing to collect — log what it said instead,
      // because that text is the only clue to why it stopped.
      logger.error(
        `${label}: stopped after ${elapsed()} without calling a submit tool — said: ${String(
          result.finalOutput ?? '',
        ).slice(0, 400)}`,
      );
      return false;
    }
    logger.log(
      `${label}: completed in ${elapsed()} (${wrapped.usage.inputTokens} in / ${wrapped.usage.outputTokens} out tokens)`,
    );
    return true;
  } catch (error) {
    if (error instanceof MaxTurnsExceededError) {
      // Usage still has to be reported: a pass that fails cost tokens too.
      addPassUsage(context, stage, wrapped.usage);
      logger.error(
        `${label}: hit the ${options.maxSteps}-turn limit after ${elapsed()} without submitting`,
      );
      return false;
    }
    // Logged by the caller, which knows which pass of which listing broke.
    throw error;
  } finally {
    context.stats[stage].durationMs = Date.now() - started;
    context.stats[stage].completed = context.finished;
    context.activeStage = null;
  }
}

/**
 * A single-turn pass with no tools: the model's final message is the answer,
 * validated against `outputType` by the SDK.
 *
 * Returns null if the model produced no answer. An answer that fails the schema
 * or a refusal throws — after the tokens it cost are counted — for the caller to
 * log and treat as a pass that produced nothing.
 */
export async function runStructuredPass<T extends z.ZodType>(
  options: StructuredPassOptions<T>,
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
    modelSettings: { temperature: options.temperature },
  });
  const wrapped = new SdkRunContext(context);
  let output: z.infer<T> | null = null;

  try {
    const result = await run(agent, toAgentInput(options.messages), {
      context: wrapped,
      // No tools, so the answer arrives on the first turn or not at all.
      maxTurns: 1,
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
      logger.error(`${label}: hit the turn limit after ${elapsed()}`);
      return null;
    }
    // Logged by the caller, which knows which pass of which listing broke.
    throw error;
  } finally {
    addPassUsage(context, stage, wrapped.usage);
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
