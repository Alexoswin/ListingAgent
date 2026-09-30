import {
  Agent,
  MaxTurnsExceededError,
  RunContext as SdkRunContext,
  RunReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  run,
  type AgentInputItem,
  type FunctionTool,
  type RunItem,
} from '@openai/agents';
import type { z } from 'zod';
import type { LlmMessage, LlmReasoningEffort } from '../llm/llm.types';
import type { ListingTrace, TraceLevel } from './trace';
import { recordUsage, type AgentStage, type RunContext } from './types';

/** Everything runPass needs to run one step. */
export interface PassOptions<T extends z.ZodType> {
  model: string;
  system: string;
  messages: LlmMessage[];
  outputType: T;
  /** Tools the AI is allowed to use, like looking at photos or searching the web. */
  tools?: FunctionTool<RunContext, any, any>[];
  maxSteps: number;
  reasoningEffort: LlmReasoningEffort;
  /** Info about the listing being worked on, shared with the tools. */
  context: RunContext;
  label: string;
  /** Which step this is: 'generation' or 'validation'. */
  stage: AgentStage;
  /** Turns the final answer into one short line for the terminal. */
  describe: (output: z.infer<T>) => string;
}

/**
 * Runs one step of the listing agent (Generate or Verify).
 *
 * The AI can use tools as many times as it needs, then gives its final answer.
 *
 * Returns the answer, or null if the AI ran out of turns.
 */
export async function runPass<T extends z.ZodType>(
  options: PassOptions<T>,
): Promise<z.infer<T> | null> {
  const { context, stage } = options;
  const stats = context.stats[stage];

  // Remember which step is running, so tokens used by tools are counted for this step.
  context.activeStage = stage;
  stats.model = options.model;
  const started = Date.now();

  // Set up the AI agent: its model, instructions, tools, and answer shape.
  const agent = new Agent<RunContext, T>({
    name: options.label,
    model: options.model,
    instructions: options.system,
    outputType: options.outputType,
    tools: options.tools ?? [],
    modelSettings: {
      // 'summary' asks for a short note on what the AI is thinking, which we print.
      reasoning: { effort: options.reasoningEffort, summary: 'auto' },
    },
  });

  // Wrap our listing info for the OpenAI library.
  // Doing it ourselves lets us read the token count while the step is running.
  const sdkContext = new SdkRunContext(context);

  // Print the step's heading in the terminal, e.g. "⏺ Generate gpt-5.6-luna · reasoning low".
  context.trace.passStarted(
    stage,
    options.model,
    options.reasoningEffort,
    sdkContext.usage,
  );

  // How the step ended, printed at the end. Stays 'failed' if something throws.
  let outcome: { text: string; level: TraceLevel } = {
    text: 'failed',
    level: 'error',
  };

  try {
    // Start the AI. 'stream: true' means we get each step as soon as it happens.
    const result = await run(agent, toAgentInput(options.messages), {
      context: sdkContext,
      maxTurns: options.maxSteps,
      stream: true,
    });

    // Print each thing the AI does (thinking, calling a tool, getting a result) as it happens.
    for await (const event of result) {
      if (event.type === 'run_item_stream_event') {
        traceItem(context.trace, event.item);
      }
    }

    // Wait until the AI is completely done.
    await result.completed;

    // Take the final answer, or null if there isn't one.
    const output = (result.finalOutput ?? null) as z.infer<T> | null;
    stats.completed = output !== null;
    outcome =
      output === null
        ? { text: 'stopped without an answer', level: 'error' }
        : { text: options.describe(output), level: 'ok' };
    return output;
  } catch (error) {
    // The AI used all its turns without answering. Return null so a human reviews the listing.
    if (error instanceof MaxTurnsExceededError) {
      outcome = {
        text: `hit the ${options.maxSteps}-turn limit without answering`,
        level: 'error',
      };
      return null;
    }
    // Any other error is passed up for the caller to handle.
    throw error;
  } finally {
    // This always runs, even if something failed, because we pay for tokens either way.
    // Add this step's tokens to the listing's total and to this step's stats.
    recordUsage(context, sdkContext.usage);
    stats.durationMs = Date.now() - started;

    // No step is running any more.
    context.activeStage = null;

    // Print how the step ended, with its time and tokens.
    context.trace.passEnded(outcome, stats);
  }
}

/**
 * Prints one thing the AI did to the terminal:
 * its thinking, a tool it called, or what a tool gave back.
 */
function traceItem(trace: ListingTrace, item: RunItem) {
  if (item instanceof RunReasoningItem) {
    // The AI's thinking, e.g. "✻ Crafting JSON specs".
    trace.reasoning(item.rawItem.content.map((part) => part.text));
  } else if (
    item instanceof RunToolCallItem &&
    item.rawItem.type === 'function_call'
  ) {
    // The AI asked to use a tool, e.g. analyze_images.
    trace.toolCalled(
      item.rawItem.callId,
      item.rawItem.name,
      item.rawItem.arguments,
    );
  } else if (
    item instanceof RunToolCallOutputItem &&
    item.rawItem.type === 'function_call_result'
  ) {
    // The tool finished and gave back its result.
    trace.toolReturned(item.rawItem.callId, item.output);
  }
}

/**
 * Converts our messages into the format the OpenAI library expects.
 * Only the labels change: 'text' becomes 'input_text', and 'image' becomes 'input_image'.
 */
function toAgentInput(messages: LlmMessage[]): AgentInputItem[] {
  return messages.map((message): AgentInputItem => ({
    role: 'user',
    content:
      // Plain text is sent as is. A list of text and photos is converted piece by piece.
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) =>
            part.type === 'text'
              ? { type: 'input_text' as const, text: part.text }
              : { type: 'input_image' as const, image: part.url },
          ),
  }));
}
