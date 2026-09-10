import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { LlmProviderName } from '../llm/llm.types';

export interface ModelChoice {
  provider: LlmProviderName;
  model: string;
}

export interface AgentConfig {
  /** Drafting pass, and the vision and lookup calls it makes. */
  generate: ModelChoice;
  /** Verification pass — a different provider wherever possible. */
  verify: ModelChoice;
  search: { backend: 'tavily' | 'serper' | 'none'; apiKey: string | null };
  /**
   * True when the passes run on different providers. When false they share one
   * model's blind spots, so a photo that misleads the first tends to mislead
   * the second the same way and the deterministic rules carry more of the load.
   */
  decorrelated: boolean;
  concurrency: number;
}

const DEFAULT_MODEL: Record<LlmProviderName, string> = {
  openai: 'gpt-4.1-mini',
  gemini: 'gemini-2.5-flash',
};

const logger = new Logger('AgentConfig');

/**
 * Picks the models for a run.
 *
 * With both keys present the passes are split across providers on purpose: a
 * second opinion from the same model on the same photo is barely a second
 * opinion, because the priors that produced the first reading produce the
 * second one too. Different providers do not share training data, so a spec one
 * fills in from memory is one the other is unlikely to fill in identically —
 * and the disagreement is exactly the signal that should reach a person.
 */
export function resolveAgentConfig(config: ConfigService): AgentConfig {
  const get = (key: string) => config.get<string>(key);
  const available = (['gemini', 'openai'] as const).filter((provider) =>
    get(provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'),
  );
  if (available.length === 0) {
    throw new Error(
      'Set at least one of OPENAI_API_KEY or GEMINI_API_KEY in .env',
    );
  }

  const generateProvider =
    (get('AGENT_GENERATE_PROVIDER') as LlmProviderName) ?? available[0];
  const verifyProvider =
    (get('AGENT_VERIFY_PROVIDER') as LlmProviderName) ??
    available.find((provider) => provider !== generateProvider) ??
    generateProvider;

  const decorrelated = generateProvider !== verifyProvider;
  if (!decorrelated) {
    logger.warn(
      `Both passes run on "${generateProvider}". Set the other provider's API key to decorrelate them.`,
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
    generate: {
      provider: generateProvider,
      model: get('AGENT_GENERATE_MODEL') ?? DEFAULT_MODEL[generateProvider],
    },
    verify: {
      provider: verifyProvider,
      model: get('AGENT_VERIFY_MODEL') ?? DEFAULT_MODEL[verifyProvider],
    },
    search,
    decorrelated,
    concurrency: Number(get('AGENT_CONCURRENCY') ?? 3),
  };
}
