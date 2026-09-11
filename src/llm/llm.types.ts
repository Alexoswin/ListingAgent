import type { z } from 'zod';

// Types for the LLM wrapper. Callers use these shapes; `LlmService` translates
// them to and from the OpenAI SDK's format.

/** One piece of a user message: text, or an image given as an http(s) or data: URL. */
export type LlmContentPart =
  { type: 'text'; text: string } | { type: 'image'; url: string };

/** One prompt turn: text, or text interleaved with images. */
export type LlmMessage = { role: 'user'; content: string | LlmContentPart[] };

/** Input for `generate()`. */
export interface LlmRequest {
  /** Which OpenAI model to use, e.g. 'gpt-4.1-mini'. */
  model: string;
  /** Optional system prompt: instructions that frame the whole conversation. */
  system?: string;
  messages: LlmMessage[];
  /** Lower values give more predictable output. */
  temperature?: number;
  /** Upper limit on how many tokens the model may generate. */
  maxOutputTokens?: number;
}

/**
 * Input for `generateObject()`: an `LlmRequest` plus the shape of the answer.
 */
// OpenAI strict mode requires every field to be present: use .nullable(), not .optional().
export interface LlmObjectRequest<T> extends LlmRequest {
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

/** Result of `generateObject()`: the parsed, schema-validated object. */
export interface LlmObjectResponse<T> {
  model: string;
  object: T;
  usage: LlmUsage;
}
