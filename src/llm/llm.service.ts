import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { parseObject, toJsonSchema } from './json-schema';
import type {
  LlmContentPart,
  LlmMessage,
  LlmObjectRequest,
  LlmObjectResponse,
  LlmRequest,
  LlmUsage,
  LlmWebSearchRequest,
  LlmWebSearchResponse,
} from './llm.types';

type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type ChatParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Response = OpenAI.Responses.Response;

const API_KEY_VAR = 'OPENAI_API_KEY';

/**
 * One-shot structured generation: give it a zod schema, get back a validated
 * object of that shape.
 *
 * The agent loop does not come through here — that runs on the Agents SDK in
 * `agent-runner`. This covers the calls that are a single question with a known
 * answer shape, where a loop would be overhead.
 */
@Injectable()
export class LlmService {
  private cached: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Returns an object validated against `request.schema`. */
  async generateObject<T>(
    request: LlmObjectRequest<T>,
  ): Promise<LlmObjectResponse<T>> {
    const completion = await this.client().chat.completions.create({
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
      model: request.model,
      object: parseObject(request.schema, choice.message.content ?? ''),
      usage: usageOf(completion),
    };
  }

  /**
   * `generateObject()`, but the model searches the web before it answers.
   *
   * This one runs on the Responses API, because that is where OpenAI's hosted
   * web search lives. `tool_choice: 'required'` forces at least one search, so
   * the answer cannot quietly come from memory while looking researched.
   */
  async generateObjectWithWebSearch<T>(
    request: LlmWebSearchRequest<T>,
  ): Promise<LlmWebSearchResponse<T>> {
    const response = await this.client().responses.create({
      model: request.model,
      instructions: request.system,
      input: request.messages.map(toResponsesMessage),
      tools: [
        {
          type: 'web_search',
          ...(request.searchCountry && {
            user_location: {
              type: 'approximate',
              country: request.searchCountry,
            },
          }),
        },
      ],
      tool_choice: 'required',
      // Without this the response lists only the URLs the model chose to cite.
      include: ['web_search_call.action.sources'],
      text: {
        format: {
          type: 'json_schema',
          name: request.schemaName,
          schema: toJsonSchema(request.schema),
          strict: true,
        },
      },
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
      ...(request.maxOutputTokens !== undefined && {
        max_output_tokens: request.maxOutputTokens,
      }),
    });
    // Same failure modes as `generateObject()`: cut off, or declined.
    if (response.status === 'incomplete') {
      throw new Error(
        `OpenAI response was incomplete: ${response.incomplete_details?.reason ?? 'unknown reason'}`,
      );
    }
    const refusal = refusalOf(response);
    if (refusal) {
      throw new Error(`OpenAI refused the request: ${refusal}`);
    }

    return {
      model: request.model,
      object: parseObject(request.schema, response.output_text),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
      sources: webSources(response),
    };
  }

  /** The OpenAI client, created on first use and reused after that. */
  private client(): OpenAI {
    if (!this.cached) {
      const apiKey = this.config.get<string>(API_KEY_VAR);
      // Fail with a clear message instead of an opaque auth error from the SDK.
      if (!apiKey) {
        throw new Error(`${API_KEY_VAR} is not set`);
      }
      this.cached = new OpenAI({ apiKey });
    }
    return this.cached;
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

/** Converts one of our prompt turns to OpenAI's message format. */
function toOpenAiMessage(
  message: LlmMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  return {
    role: 'user',
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map(toOpenAiPart),
  };
}

/** Converts a text/image part. OpenAI downloads image URLs itself, so the URL is passed through. */
function toOpenAiPart(
  part: LlmContentPart,
): OpenAI.Chat.Completions.ChatCompletionContentPart {
  return part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image_url', image_url: { url: part.url } };
}

/** The Responses API's version of `toOpenAiMessage()`. */
function toResponsesMessage(
  message: LlmMessage,
): OpenAI.Responses.EasyInputMessage {
  return {
    role: 'user',
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) =>
            part.type === 'text'
              ? { type: 'input_text' as const, text: part.text }
              : {
                  type: 'input_image' as const,
                  image_url: part.url,
                  detail: 'auto' as const,
                },
          ),
  };
}

/** The refusal text, if the model declined instead of answering. */
function refusalOf(response: Response): string | null {
  for (const item of response.output) {
    if (item.type !== 'message') {
      continue;
    }
    for (const part of item.content) {
      if (part.type === 'refusal') {
        return part.refusal;
      }
    }
  }
  return null;
}

/**
 * Every URL the search turned up, de-duplicated: the sources of each search
 * call, plus any URL the answer cites.
 */
function webSources(response: Response): string[] {
  const urls = response.output.flatMap((item): string[] => {
    if (item.type === 'web_search_call') {
      return item.action.type === 'search'
        ? (item.action.sources ?? []).map((source) => source.url)
        : [];
    }
    if (item.type === 'message') {
      return item.content.flatMap((part) =>
        part.type === 'output_text'
          ? part.annotations.flatMap((annotation) =>
              annotation.type === 'url_citation' ? [annotation.url] : [],
            )
          : [],
      );
    }
    return [];
  });
  return [...new Set(urls)];
}
