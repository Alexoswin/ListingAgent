import { z } from 'zod';

/**
 * Converts a zod schema to plain JSON Schema, the format OpenAI expects for
 * tool arguments and structured output.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  // zod adds a "$schema" version marker that OpenAI doesn't need.
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
