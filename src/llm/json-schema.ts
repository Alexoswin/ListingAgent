import { z } from 'zod';

/**
 * Converts a zod schema to plain JSON Schema, the format both OpenAI and Gemini
 * expect for tool arguments and structured output.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  // zod adds a "$schema" version marker that the providers don't need.
  delete jsonSchema.$schema;
  return jsonSchema;
}

/**
 * Parses the model's JSON text and checks it against the zod schema.
 * Throws if the JSON is malformed or doesn't match the expected shape.
 */
export function parseObject<T>(schema: z.ZodType<T>, text: string): T {
  return schema.parse(JSON.parse(text) as unknown);
}
