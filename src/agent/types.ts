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

/**
 * A problem found by the draft checker. `blocking` forces `human_review_needed`
 * whatever either model concluded — these are the checks that cover the failure
 * two passes cannot, where the evidence itself misleads both of them.
 */
export interface Violation {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
}

/** Where a lookup's answer actually came from. */
export interface ProductLookupResult extends ProductLookup {
  evidence: 'web' | 'model_knowledge';
}

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
  violations: Violation[];
  usage: { inputTokens: number; outputTokens: number };
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
    violations: [],
    usage: { inputTokens: 0, outputTokens: 0 },
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
