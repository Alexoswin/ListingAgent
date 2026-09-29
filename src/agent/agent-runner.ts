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
import type { AgentStage, RunContext } from './types';

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
  /** Which step this is: 'generate' or 'verify'. */
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
  const { context, label, stage } = options;

  // Remember which step is running, so tokens used by tools are counted for this step.
  context.activeStage = stage;
  context.stats[stage].model = options.model;

  // Note the start time, so we can work out how long the step took.
  const started = Date.now();

  // Set up the AI agent: its model, instructions, tools, and answer shape.
  const agent = new Agent<RunContext, T>({
    name: label,
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
  const wrapped = new SdkRunContext(context);

  // Print the step's heading in the terminal, e.g. "⏺ Generate gpt-5.6-luna · reasoning low".
  context.trace.passStarted(
    stage,
    options.model,
    options.reasoningEffort,
    wrapped.usage,
  );

  // The AI's final answer. Stays null until we get one.
  let output: z.infer<T> | null = null;

  // The result we print at the end. We assume it failed until it succeeds.
  let outcome: { text: string; level: TraceLevel } = {
    text: 'failed',
    level: 'error',
  };

  try {
    // Start the AI. 'stream: true' means we get each step as soon as it happens.
    const result = await run(agent, toAgentInput(options.messages), {
      context: wrapped,
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
    output = (result.finalOutput ?? null) as z.infer<T> | null;
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

    // Add this step's tokens to the listing's total.
    context.usage.inputTokens += wrapped.usage.inputTokens;
    context.usage.outputTokens += wrapped.usage.outputTokens;

    // Save this step's tokens, time taken, and whether it finished.
    context.stats[stage].inputTokens += wrapped.usage.inputTokens;
    context.stats[stage].outputTokens += wrapped.usage.outputTokens;
    context.stats[stage].durationMs = Date.now() - started;
    context.stats[stage].completed = output !== null;

    // No step is running any more.
    context.activeStage = null;

    // Print how the step ended, with its time and tokens.
    context.trace.passEnded(outcome, context.stats[stage]);
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
 * The content stays the same; only the labels change:
 * 'text' becomes 'input_text', and 'image' becomes 'input_image'.
 */
function toAgentInput(messages: LlmMessage[]): AgentInputItem[] {
  return messages.flatMap((message): AgentInputItem[] => {
    // Skip anything not sent by us. (This never happens now, because we only send user messages.)
    if (message.role !== 'user') {
      return [];
    }
    return [
      {
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
      },
    ];
  });
}
