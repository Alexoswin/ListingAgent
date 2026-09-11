import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/** Drafting runs on the cheaper model; verification gets the stronger one. */
const DEFAULT_GENERATE_MODEL = 'gpt-4.1-mini';
const DEFAULT_VERIFY_MODEL = 'gpt-4.1';

export interface AgentConfig {
  /** Drafting pass, and the vision and lookup calls it makes. */
  generate: string;
  /** Verification pass — a different model wherever possible. */
  verify: string;
  search: { backend: 'tavily' | 'serper' | 'none'; apiKey: string | null };
  /**
   * True when the passes run on different models. When false they share one
   * model's blind spots, so a photo that misleads the first tends to mislead
   * the second the same way and the deterministic rules carry more of the load.
   */
  decorrelated: boolean;
  concurrency: number;
}

const logger = new Logger('AgentConfig');

/**
 * Picks the models for a run.
 *
 * The passes default to different models on purpose: a second opinion from the
 * same model on the same photo is barely a second opinion, because the priors
 * that produced the first reading produce the second one too. Two models from
 * one family share training data, so this decorrelates the passes less than two
 * vendors would — the deterministic checks in `draft-checker` are what actually
 * catch the failure both passes share.
 */
export function resolveAgentConfig(config: ConfigService): AgentConfig {
  const get = (key: string) => config.get<string>(key);

  if (!get('OPENAI_API_KEY')) {
    throw new Error('Set OPENAI_API_KEY in .env');
  }

  const generate = get('AGENT_GENERATE_MODEL') ?? DEFAULT_GENERATE_MODEL;
  const verify = get('AGENT_VERIFY_MODEL') ?? DEFAULT_VERIFY_MODEL;

  const decorrelated = generate !== verify;
  if (!decorrelated) {
    logger.warn(
      `Both passes run on "${generate}". Set AGENT_VERIFY_MODEL to a different model to decorrelate them.`,
    );
  }

  const search = get('TAVILY_API_KEY')
    ? { backend: 'tavily' as const, apiKey: get('TAVILY_API_KEY') as string }
    : get('SERPER_API_KEY')
      ? { backend: 'serper' as const, apiKey: get('SERPER_API_KEY') as string }
      : { backend: 'none' as const, apiKey: null };

  if (search.backend === 'none') {
    logger.warn(
      'No TAVILY_API_KEY or SERPER_API_KEY: product lookup falls back to model knowledge, and every MRP it returns is marked unverified.',
    );
  }

  return {
    generate,
    verify,
    search,
    decorrelated,
    concurrency: Number(get('AGENT_CONCURRENCY') ?? 3),
  };
}
