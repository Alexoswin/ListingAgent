import { randomUUID } from 'node:crypto';
import {
  FinishReason,
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
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

const IMAGE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Gemini implementation of `LlmProvider`, using Google's @google/genai SDK.
 * Same job as the OpenAI provider, but Gemini's format differs: the conversation
 * is a list of `contents` made of `parts`, the assistant role is called `model`,
 * and images are sent as raw bytes.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  /** Sends the conversation (and any tools) and returns text and/or tool calls. */
  async generate(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.send(
      request,
      // Gemini groups all tool definitions under one `functionDeclarations` list.
      request.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: toJsonSchema(tool.parameters),
                })),
              },
            ],
          }
        : {},
    );
    const parts = contentParts(response);

    return {
      provider: this.name,
      model: request.model,
      text: textOf(parts),
      // Gemini mixes text and tool calls in the same `parts` list; pick out the calls.
      toolCalls: parts.flatMap(({ functionCall, thoughtSignature }) =>
        functionCall
          ? [
              {
                // Gemini doesn't always give calls an id, so we make one for our own bookkeeping.
                id: functionCall.id ?? randomUUID(),
                name: functionCall.name ?? '',
                args: functionCall.args ?? {},
                // Kept so it can be sent back unchanged on the next turn.
                ...(thoughtSignature && { thoughtSignature }),
              },
            ]
          : [],
      ),
      usage: usageOf(response),
    };
  }

  /** Asks for a JSON answer matching `request.schema` and returns it as a validated object. */
  async generateObject<T>(
    request: LlmObjectRequest<T>,
  ): Promise<LlmObjectResponse<T>> {
    const response = await this.send(request, {
      responseMimeType: 'application/json',
      responseJsonSchema: toJsonSchema(request.schema),
    });
    const parts = contentParts(response);
    // MAX_TOKENS means the token limit cut the answer off, so the JSON is incomplete.
    if (response.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS) {
      throw new Error('Gemini response was truncated before the JSON finished');
    }

    return {
      provider: this.name,
      model: request.model,
      object: parseObject(request.schema, textOf(parts)),
      usage: usageOf(response),
    };
  }

  /** Request logic shared by `generate()` and `generateObject()`. */
  private async send(
    request: Omit<LlmRequest, 'tools'>,
    config: GenerateContentConfig,
  ): Promise<GenerateContentResponse> {
    return this.client.models.generateContent({
      model: request.model,
      // Async because image URLs must be downloaded before the request is sent.
      contents: await toGeminiContents(request.messages),
      config: {
        ...config,
        // Optional settings are only sent when set, so Gemini's defaults apply otherwise.
        ...(request.system && { systemInstruction: request.system }),
        ...(request.temperature !== undefined && {
          temperature: request.temperature,
        }),
        ...(request.maxOutputTokens !== undefined && {
          maxOutputTokens: request.maxOutputTokens,
        }),
      },
    });
  }
}

/**
 * Returns the parts of Gemini's answer. Throws with the reason when there is
 * no answer, e.g. when a safety filter blocked it.
 */
function contentParts(response: GenerateContentResponse): Part[] {
  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts) {
    const reason =
      response.promptFeedback?.blockReason ??
      candidate?.finishReason ??
      'unknown';
    throw new Error(`Gemini returned no content (reason: ${reason})`);
  }
  return candidate.content.parts;
}

/** Joins the text parts into one string, skipping the model's internal "thought" parts. */
function textOf(parts: Part[]): string {
  return parts
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text ?? '')
    .join('');
}

/** Maps Gemini's token counts to our shape. Thinking tokens are billed as output, so they're included. */
function usageOf(response: GenerateContentResponse): LlmUsage {
  const usage = response.usageMetadata;
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens:
      (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  };
}

/** Converts our conversation history to Gemini's `contents` format. */
async function toGeminiContents(messages: LlmMessage[]): Promise<Content[]> {
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      // Tool results go back as `functionResponse` parts in a user turn.
      // Gemini links them to calls by name, so no id is needed.
      const part: Part = {
        functionResponse: {
          name: message.name,
          response: { result: message.content },
        },
      };
      const previous = contents.at(-1);
      // Gemini expects all responses to one turn's function calls in a single content.
      if (
        previous?.role === 'user' &&
        previous.parts?.every((existing) => existing.functionResponse)
      ) {
        previous.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
      continue;
    }

    if (message.role === 'assistant') {
      // The model's earlier turn: its text plus the tool calls it made.
      contents.push({
        role: 'model',
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          // The id is left out on purpose: it may be one we made up, not Gemini's.
          ...(message.toolCalls ?? []).map((call) => ({
            functionCall: { name: call.name, args: call.args },
            ...(call.thoughtSignature && {
              thoughtSignature: call.thoughtSignature,
            }),
          })),
        ],
      });
      continue;
    }

    // A user turn: text as-is, images downloaded in parallel and inlined.
    contents.push({
      role: 'user',
      parts:
        typeof message.content === 'string'
          ? [{ text: message.content }]
          : await Promise.all(message.content.map(toGeminiPart)),
    });
  }

  return contents;
}

// Images are sent inline because Gemini's fileData only reliably accepts Files API / GCS URIs.
async function toGeminiPart(part: LlmContentPart): Promise<Part> {
  if (part.type === 'text') {
    return { text: part.text };
  }

  // Also works for data: URLs, so local images can be passed as base64.
  const response = await fetch(part.url, {
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch image ${part.url}: HTTP ${response.status}`,
    );
  }

  return {
    inlineData: {
      // Drop extras like "; charset=..."; Gemini wants just the MIME type.
      mimeType:
        response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg',
      data: Buffer.from(await response.arrayBuffer()).toString('base64'),
    },
  };
}
