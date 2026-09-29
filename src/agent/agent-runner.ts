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
  /** One line on the answer, for the trace. */
  describe: (output: z.infer<T>) => string;
}

/**
 * The single agent pass both halves of the run use, on the Agents SDK's loop.
 *
 * The model calls tools until it is ready, then answers; the answer is the
 * pass's result, already validated against `outputType`. Every turn is held to
 * that format, so a turn is either tool calls or the finished answer.
 *
 * Returns null when the pass runs out of turns without answering. An answer
 * that fails the schema, or a refusal, throws for the caller to report. Either
 * way the tokens it cost are counted.
 */
export async function runPass<T extends z.ZodType>(
  options: PassOptions<T>,
): Promise<z.infer<T> | null> {
  const { context, label, stage } = options;
  context.activeStage = stage;
  context.stats[stage].model = options.model;
  const started = Date.now();

  const agent = new Agent<RunContext, T>({
    name: label,
    model: options.model,
    instructions: options.system,
    outputType: options.outputType,
    tools: options.tools ?? [],
    modelSettings: {
      // The summary is what the trace shows of the model's thinking.
      reasoning: { effort: options.reasoningEffort, summary: 'auto' },
    },
  });

  // Wrapped here rather than letting `run()` wrap it, so the usage the SDK
  // accumulates is readable during and after the run without reaching into
  // run state.
  const wrapped = new SdkRunContext(context);
  context.trace.passStarted(
    stage,
    options.model,
    options.reasoningEffort,
    wrapped.usage,
  );
  let output: z.infer<T> | null = null;
  // Stays as is if the pass throws; the caller reports the error itself.
  let outcome: { text: string; level: TraceLevel } = {
    text: 'failed',
    level: 'error',
  };

  try {
    // Streamed so the trace shows each step as it happens. A failed run errors
    // the stream, so the loop throws what `run()` would have.
    const result = await run(agent, toAgentInput(options.messages), {
      context: wrapped,
      maxTurns: options.maxSteps,
      stream: true,
    });
    for await (const event of result) {
      if (event.type === 'run_item_stream_event') {
        traceItem(context.trace, event.item);
      }
    }
    await result.completed;
    output = (result.finalOutput ?? null) as z.infer<T> | null;
    outcome =
      output === null
        ? { text: 'stopped without an answer', level: 'error' }
        : { text: options.describe(output), level: 'ok' };
    return output;
  } catch (error) {
    if (error instanceof MaxTurnsExceededError) {
      outcome = {
        text: `hit the ${options.maxSteps}-turn limit without answering`,
        level: 'error',
      };
      return null;
    }
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
    context.trace.passEnded(outcome, context.stats[stage]);
  }
}

/**
 * Hands the trace one step the SDK streamed. The SDK streams a turn's reasoning
 * and tool calls as soon as the model returns them, and the tools' outputs only
 * once they have all finished, so the trace prints in the order things happened.
 */
function traceItem(trace: ListingTrace, item: RunItem) {
  if (item instanceof RunReasoningItem) {
    trace.reasoning(item.rawItem.content.map((part) => part.text));
  } else if (
    item instanceof RunToolCallItem &&
    item.rawItem.type === 'function_call'
  ) {
    trace.toolCalled(
      item.rawItem.callId,
      item.rawItem.name,
      item.rawItem.arguments,
    );
  } else if (
    item instanceof RunToolCallOutputItem &&
    item.rawItem.type === 'function_call_result'
  ) {
    trace.toolReturned(item.rawItem.callId, item.output);
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
