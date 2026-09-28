import type { ConfigService } from '@nestjs/config';

/**
 * The passes run on different models on purpose: a second opinion from the
 * same model on the same photo is barely a second opinion, because the priors
 * that produced the first reading produce the second one too. Two models from
 * one family share training data, so this decorrelates the passes less than two
 * vendors would.
 *
 * Constants, not env vars: which model runs a pass is a code decision, and
 * `.env` holds secrets only. Drafting runs on the cheaper model; verification
 * gets the stronger one.
 */
const GENERATE_MODEL: string = 'gpt-4.1-mini';
const VERIFY_MODEL: string = 'gpt-4.1';

export interface AgentConfig {
  /** Drafting pass, and the vision and lookup calls it makes. */
  generate: string;
  /** Verification pass — a different model from `generate`. */
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
