import { Logger } from '@nestjs/common';
import {
  Agent,
  MaxTurnsExceededError,
  RunContext as SdkRunContext,
  run,
  type AgentInputItem,
  type FunctionTool,
} from '@openai/agents';
import type { LlmMessage } from '../llm/llm.types';
import type { RunContext } from './types';

export interface PassOptions {
  /** Which OpenAI model runs this pass. */
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: FunctionTool<RunContext, any, any>[];
  /** Guards against a model that calls tools forever without finishing. */
  maxSteps: number;
  /** The per-listing state the tools read and write. */
  context: RunContext;
  label: string;
}

const logger = new Logger('AgentRunner');

/**
 * The single agent pass both halves of the run use, on the Agents SDK's loop.
 *
 * Returns whether a tool ended it — a pass that runs out of turns without
 * submitting anything is a failure the caller has to account for, not an
 * answer.
 */
export async function runPass(options: PassOptions): Promise<boolean> {
  const { context, label } = options;
  context.finished = false;
  const started = Date.now();
  const elapsed = () => `${Date.now() - started}ms`;
  logger.log(`${label}: started on ${options.model}`);

  const agent = new Agent<RunContext>({
    name: label,
    model: options.model,
    instructions: options.system,
    tools: options.tools,
    // Low but not zero: near-deterministic, while still leaving a rejected
    // draft room to come back different on the retry.
    modelSettings: { temperature: 0.2 },
    /**
     * The loop's real exit. `stopAtToolNames` would stop on any submit_draft,
     * including a rejected one — the whole point is that a rejected draft goes
     * back for another attempt. Only the tools themselves know which it was,
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
    context.usage.inputTokens += wrapped.usage.inputTokens;
    context.usage.outputTokens += wrapped.usage.outputTokens;

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
      context.usage.inputTokens += wrapped.usage.inputTokens;
      context.usage.outputTokens += wrapped.usage.outputTokens;
      logger.error(
        `${label}: hit the ${options.maxSteps}-turn limit after ${elapsed()} without submitting`,
      );
      return false;
    }
    // Logged by the caller, which knows which pass of which listing broke.
    throw error;
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
