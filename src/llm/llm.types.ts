import type { z } from 'zod';

// Provider-neutral types for the LLM wrapper. Callers only use these shapes;
// each provider translates them to and from its own SDK's format.

/** Which backend handles a call. */
export type LlmProviderName = 'openai' | 'gemini';

/** One piece of a user message: text, or an image given as an http(s) or data: URL. */
export type LlmContentPart =
  { type: 'text'; text: string } | { type: 'image'; url: string };

/** A tool (function) call the model is asking us to run. */
export interface LlmToolCall {
  /** Links the tool's result back to this call. */
  id: string;
  /** Which tool the model wants to run. */
  name: string;
  /** The arguments the model chose, already parsed from JSON. */
  args: Record<string, unknown>;
  // Gemini rejects follow-up turns whose function calls lack their original signature.
  thoughtSignature?: string;
}

/**
 * One entry in the conversation history, oldest first:
 * `user` = the prompt, `assistant` = the model's reply (possibly with tool calls),
 * `tool` = the result of running one of those tool calls.
 */
export type LlmMessage =
  | { role: 'user'; content: string | LlmContentPart[] }
  | { role: 'assistant'; content?: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

/** A tool the model may call. `parameters` is a zod schema for its arguments. */
export interface LlmTool {
  name: string;
  /** Tells the model what the tool does and when to use it. */
  description: string;
  parameters: z.ZodType;
}

/** Input for `generate()`. */
export interface LlmRequest {
  /** Which backend to use for this call. */
  provider: LlmProviderName;
  /** Model name for that backend, e.g. 'gpt-4.1-mini' or 'gemini-2.5-flash'. */
  model: string;
  /** Optional system prompt: instructions that frame the whole conversation. */
  system?: string;
  messages: LlmMessage[];
  /** Tools the model may call. Omit for a plain answer. */
  tools?: LlmTool[];
  /** Lower values give more predictable output. */
  temperature?: number;
  /** Upper limit on how many tokens the model may generate. */
  maxOutputTokens?: number;
}

/**
 * Input for `generateObject()`: like `LlmRequest`, but instead of tools you pass a
 * zod schema and get back a validated object of that shape.
 */
// OpenAI strict mode requires every field to be present: use .nullable(), not .optional().
export interface LlmObjectRequest<T> extends Omit<LlmRequest, 'tools'> {
  /** The shape the answer must have; also used to validate it. */
  schema: z.ZodType<T>;
  /** Short identifier for the schema (OpenAI requires one). */
  schemaName: string;
}

/** Token counts for one call, useful for tracking cost. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Result of `generate()`: the model's text and/or the tools it wants to call. */
export interface LlmResponse {
  provider: LlmProviderName;
  model: string;
  /** The model's text answer; empty when it only made tool calls. */
  text: string;
  /** Tools to run next; empty when the model answered directly. */
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
}

/** Result of `generateObject()`: the parsed, schema-validated object. */
export interface LlmObjectResponse<T> {
  provider: LlmProviderName;
  model: string;
  object: T;
  usage: LlmUsage;
}

/** What each provider implementation (OpenAI, Gemini) must offer. */
export interface LlmProvider {
  readonly name: LlmProviderName;
  generate(request: LlmRequest): Promise<LlmResponse>;
  generateObject<T>(
    request: LlmObjectRequest<T>,
  ): Promise<LlmObjectResponse<T>>;
}
