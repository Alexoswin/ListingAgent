import type { ConfigService } from '@nestjs/config';

/**
 * Both passes run on the same model, to keep cost down. That is a trade-off: a
 * second opinion from the same model on the same photo is barely a second
 * opinion, because the priors that produced the first reading produce the
 * second one too. What keeps the verify pass independent is its separate
 * context (it sees the photos and the draft, none of the drafting reasoning)
 * and a higher reasoning effort, not different weights. `decorrelated` reports
 * which setup a run used.
 *
 * Both must be reasoning models: every call sends a reasoning effort, and
 * none sends a temperature, which these models reject.
 *
 * Constants, not env vars: which model runs a pass is a code decision, and
 * `.env` holds secrets only.
 */
const GENERATE_MODEL: string = 'gpt-5.6-luna';
const VERIFY_MODEL: string = 'gpt-5.6-luna';

export interface AgentConfig {
  /** Drafting pass, and the vision and lookup calls it makes. */
  generate: string;
  /** Verification pass. */
  verify: string;
  /**
   * True when the passes run on different models. When false they share one
   * model's blind spots, so a photo that misleads the first tends to mislead
   * the second the same way.
   */
  decorrelated: boolean;
  concurrency: number;
}

/** Picks the models and concurrency for a run. */
export function resolveAgentConfig(config: ConfigService): AgentConfig {
  const get = (key: string) => config.get<string>(key);

  if (!get('OPENAI_API_KEY')) {
    throw new Error('Set OPENAI_API_KEY in .env');
  }

  return {
    generate: GENERATE_MODEL,
    verify: VERIFY_MODEL,
    decorrelated: GENERATE_MODEL !== VERIFY_MODEL,
    concurrency: Number(get('AGENT_CONCURRENCY') ?? 3),
  };
}
