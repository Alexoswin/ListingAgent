import OpenAI from 'openai';
import { parseObject, toJsonSchema } from '../json-schema';
import type {
  LlmContentPart,
  LlmMessage,
  LlmObjectRequest,
  LlmObjectResponse,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmUsage,
} from '../llm.types';

type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type ChatParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/**
 * OpenAI implementation of `LlmProvider`, using the Chat Completions API.
 * Translates our neutral request/response types to OpenAI's format and back.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  /** Sends the conversation (and any tools) and returns text and/or tool calls. */
  async generate(request: LlmRequest): Promise<LlmResponse> {
    const completion = await this.client.chat.completions.create({
      ...baseParams(request),
      // Only send `tools` when there are some; OpenAI rejects an empty list.
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: toJsonSchema(tool.parameters),
              },
            })),
          }
        : {}),
    });
    const { message } = firstChoice(completion);

    return {
      provider: this.name,
      model: request.model,
      text: message.content ?? '',
      // Keep only function calls (the only tool type we declare) and parse
      // their arguments, which OpenAI returns as a JSON string.
      toolCalls: (message.tool_calls ?? []).flatMap((call) =>
        call.type === 'function'
          ? [
              {
                id: call.id,
                name: call.function.name,
                args: JSON.parse(call.function.arguments) as Record<
                  string,
                  unknown
                >,
              },
            ]
          : [],
      ),
      usage: usageOf(completion),
    };
  }

  /** Asks for a JSON answer matching `request.schema` and returns it as a validated object. */
  async generateObject<T>(
    request: LlmObjectRequest<T>,
  ): Promise<LlmObjectResponse<T>> {
    const completion = await this.client.chat.completions.create({
      ...baseParams(request),
      // `strict: true` makes OpenAI guarantee the reply matches the schema's shape.
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName,
          schema: toJsonSchema(request.schema),
          strict: true,
        },
      },
    });
    const choice = firstChoice(completion);
    // 'length' means the token limit cut the answer off, so the JSON is incomplete.
    if (choice.finish_reason === 'length') {
      throw new Error('OpenAI response was truncated before the JSON finished');
    }
    // The model declined to answer (for example, for safety reasons).
    if (choice.message.refusal) {
      throw new Error(`OpenAI refused the request: ${choice.message.refusal}`);
    }

    return {
      provider: this.name,
      model: request.model,
      object: parseObject(request.schema, choice.message.content ?? ''),
      usage: usageOf(completion),
    };
  }
}

/** Builds the request fields shared by `generate()` and `generateObject()`. */
function baseParams(request: Omit<LlmRequest, 'tools'>): ChatParams {
  return {
    model: request.model,
    messages: [
      // The system prompt goes first, as its own message.
      ...(request.system
        ? [{ role: 'system' as const, content: request.system }]
        : []),
      ...request.messages.map(toOpenAiMessage),
    ],
    // Optional settings are only sent when set, so OpenAI's defaults apply otherwise.
    ...(request.temperature !== undefined && {
      temperature: request.temperature,
    }),
    ...(request.maxOutputTokens !== undefined && {
      max_completion_tokens: request.maxOutputTokens,
    }),
  };
}

/** OpenAI returns a list of alternative answers ("choices"); we always use the first. */
function firstChoice(completion: ChatCompletion) {
  const choice = completion.choices[0];
  if (!choice) {
    throw new Error('OpenAI returned no choices');
  }
  return choice;
}

/** Maps OpenAI's token counts to our `LlmUsage` shape. */
function usageOf(completion: ChatCompletion): LlmUsage {
  return {
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
  };
}

/** Converts one of our messages to OpenAI's message format. */
function toOpenAiMessage(
  message: LlmMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (message.role) {
    case 'user':
      return {
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map(toOpenAiPart),
      };
    case 'assistant':
      // Replays the model's earlier turn, including its tool calls, so OpenAI
      // can match them with the tool results that follow.
      return {
        role: 'assistant',
        content: message.content ?? null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: {
                  name: call.name,
                  // OpenAI expects the arguments back as a JSON string.
                  arguments: JSON.stringify(call.args),
                },
              })),
            }
          : {}),
      };
    case 'tool':
      // `tool_call_id` tells OpenAI which call this result answers.
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}

/** Converts a text/image part. OpenAI downloads image URLs itself, so the URL is passed through. */
function toOpenAiPart(
  part: LlmContentPart,
): OpenAI.Chat.Completions.ChatCompletionContentPart {
  return part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image_url', image_url: { url: part.url } };
}
