import type { JsonRecord } from '../common/types/json-value';
import type { LlmContentPart } from '../llm/llm.types';
import type { Category, Subcategory } from '../listings/enums/category.enum';
import type { FetchedImage } from './image-fetcher';
import type {
  AgentReview,
  GeneratedPdp,
  ImageAnalysis,
  ProductLookup,
} from './schemas';

/**
 * One raw submission from `data/listings.json`. Everything under `seller` is a
 * claim, not ground truth; `specs` and `condition_details` are whatever the
 * category's form collected, so they stay free-form.
 */
export interface SellerListing {
  listing_id: string;
  category: Category;
  subcategory?: Subcategory;
  seller: {
    title: string;
    description: string;
    price: number;
    original_price: number | null;
    brand: string | null;
    model: string | null;
    year_purchased: string | null;
    specs: JsonRecord;
    condition_details: JsonRecord;
  };
  images: string[];
}

/** Where a lookup's answer actually came from. */
export interface ProductLookupResult extends ProductLookup {
  evidence: 'web' | 'model_knowledge';
}

export const AGENT_TOOL_NAMES = [
  'analyze_images',
  'product_lookup',
  'submit_draft',
  'submit_review',
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];
export type AgentStage = 'generation' | 'validation';

export interface AgentStageStats {
  model: string | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  completed: boolean;
  toolCalls: Record<AgentToolName, number>;
}

export interface AgentRunStats {
  generation: AgentStageStats;
  validation: AgentStageStats;
}

const createStageStats = (): AgentStageStats => ({
  model: null,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  completed: false,
  toolCalls: Object.fromEntries(
    AGENT_TOOL_NAMES.map((name) => [name, 0]),
  ) as Record<AgentToolName, number>,
});

export const createAgentRunStats = (): AgentRunStats => ({
  generation: createStageStats(),
  validation: createStageStats(),
});

export const recordToolCall = (context: RunContext, tool: AgentToolName) => {
  const stage = context.activeStage;
  if (stage) {
    context.stats[stage].toolCalls[tool] += 1;
  }
};

/**
 * Counts a model call a tool made against the run and against the pass that
 * made it.
 *
 * The Agents SDK only sees the pass's own turns, so a tool's vision or search
 * call is invisible to it. Without this, those tokens reach the run's total but
 * no pass — and the image analysis, the most expensive call on the cheaper
 * model, disappears from any per-stage breakdown.
 */
export const recordUsage = (
  context: RunContext,
  usage: { inputTokens: number; outputTokens: number },
) => {
  context.usage.inputTokens += usage.inputTokens;
  context.usage.outputTokens += usage.outputTokens;
  const stage = context.activeStage;
  if (stage) {
    context.stats[stage].inputTokens += usage.inputTokens;
    context.stats[stage].outputTokens += usage.outputTokens;
  }
};

/**
 * Per-listing state for one run, shared by the tools.
 *
 * Tools take a `listing_id` and read and write here rather than passing results
 * through the model: handing a tool's output back only to have it retyped as
 * the next tool's argument costs tokens on every hop and quietly loses fields,
 * because models paraphrase JSON they copy.
 */
export interface RunContext {
  listing: SellerListing;
  images: FetchedImage[];
  analysis: ImageAnalysis | null;
  lookups: ProductLookupResult[];
  draft: GeneratedPdp | null;
  review: AgentReview | null;
  /**
   * Set by whichever tool ends a pass. The Agents SDK loop reads it once per
   * turn to decide whether the pass is finished — a submission with the wrong
   * shape leaves it false so the model can resubmit.
   */
  finished: boolean;
  usage: { inputTokens: number; outputTokens: number };
  activeStage: AgentStage | null;
  stats: AgentRunStats;
}

export function createRunContext(
  listing: SellerListing,
  images: FetchedImage[],
): RunContext {
  return {
    listing,
    images,
    analysis: null,
    lookups: [],
    draft: null,
    review: null,
    finished: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    activeStage: null,
    stats: createAgentRunStats(),
  };
}

/** The images that actually loaded — the only ones a claim may cite. */
export const usableImages = (context: RunContext): FetchedImage[] =>
  context.images.filter((image) => image.ok);

/**
 * The usable images as message parts, each preceded by its index so the model
 * can cite one. Both passes attach the same parts from the same cached bytes.
 */
export const imageParts = (context: RunContext): LlmContentPart[] =>
  usableImages(context).flatMap((image) => [
    { type: 'text' as const, text: `Image ${image.index}:` },
    { type: 'image' as const, url: image.dataUrl as string },
  ]);

/** A one-line summary of the listing's images, for both prompts. */
export function describeImages(context: RunContext): string {
  const failed = context.images.filter((image) => !image.ok);
  const loaded = context.images.length - failed.length;
  const base = `Images: ${context.images.length} submitted, ${loaded} loaded.`;
  return failed.length === 0
    ? base
    : `${base} Did not load, and cannot be cited: ${failed
        .map((image) => `${image.index} (${image.error})`)
        .join(', ')}.`;
}
