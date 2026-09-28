import type { LlmService } from '../llm/llm.service';
import { CATEGORY_SUBCATEGORIES } from '../listings/enums/category.enum';
import type { AgentConfig } from './agent.config';
import { draftCheckSchema } from './schemas';
import {
  describeImages,
  recordUsage,
  type RunContext,
  type Violation,
} from './types';

/** The whole taxonomy, one category per line, for the subcategory rule. */
const TAXONOMY = Object.entries(CATEGORY_SUBCATEGORIES)
  .map(
    ([category, subcategories]) => `- ${category}: ${subcategories.join(', ')}`,
  )
  .join('\n');

const CHECK_SYSTEM = `You audit a drafted marketplace listing for a second-hand item before it is accepted. You did not write it. Your job is to find every place the draft breaks the rules below, using only the evidence in front of you: the seller's submission, which images loaded, what the image analysis reported, and what the product lookup returned.

You do not see the photographs. Judge the draft against the evidence as reported, not against what the item probably is.

Report each problem as a violation with a code, a severity, and a one-sentence message naming the exact spec, entry or value at fault. Use the codes below; if a problem fits none of them, give it a short snake_case code of your own. Report nothing that is not a problem — an empty list is the right answer for a clean draft.

"blocking" means the draft must not be accepted as it stands. "warning" means a human should know, but the draft may stand.

## Evidence base
- no_usable_images (blocking) — no image loaded.
- stock_photo (blocking) — the analysis flagged any image as a catalogue render rather than the actual unit.
- brand_mismatch (blocking) — the brand visible in the photos is a different brand from the one the seller named. Spelling, abbreviation and parent-company differences ("HP" / "Hewlett-Packard", "Mi" / "Xiaomi") are the same brand.

## Specifications
- no_specifications (blocking) — the draft carries none.
- low_confidence_spec (warning) — a spec's confidence is below 0.4.
- image_spec_without_index (blocking) — source "image" but image_index is null.
- spec_cites_unusable_image (blocking) — the cited image did not load.
- spec_from_illegible_evidence (blocking) — an image-sourced spec whose detail the analysis reported as not legible.
- spec_not_corroborated_by_analysis (warning) — an image-sourced spec the analysis never reported at all. Match by meaning: "Memory: 8 GB" is the same observation as "RAM 8GB"; "Frame" is not "RAM".
- title_claims_unlisted_spec (blocking) — the title advertises a spec-like value (capacity, size, seat count, speed…) that no specification carries. Equivalent units and precision are fine: 15.6" in the specs supports "15.6 inch" in the title.

## Seller corrections
Overriding the seller is allowed — evidence outranks seller text — but never silently.
- correction_image_without_index (blocking) — evidence "image" but image_index is null.
- correction_cites_unusable_image (blocking) — the cited image did not load.
- correction_without_lookup (blocking) — evidence "lookup" but no lookup was run.
- correction_quotes_unknown_text (warning) — seller_claim quotes something the seller never said in title, description, brand, model or specs.
- unrecorded_seller_correction (warning) — the draft publishes a value that contradicts one the seller gave (title, description, brand, model or specs) and seller_corrections has no entry for it. Adding precision is not a contradiction ("15 inch" → "15.6 inches", "13th gen" → "i7-13620H"); a different value is ("16 GB" → "8 GB", "27 inch" → "24 inch", IPS → VA). A seller claim the draft simply leaves out is not a correction either.

## Original MRP
- mrp_without_source (blocking) — original_mrp is set but its source is "none".
- mrp_not_above_price (blocking) — original_mrp is not above the seller's asking price.
- mrp_from_model_knowledge (warning) — the source is "lookup_model_knowledge".

## Seller disclosures
The draft must carry one seller_disclosures entry for every non-empty string anywhere in the seller's condition_details, with source_text copied exactly.
- unaccounted_seller_disclosure (blocking) — a value in condition_details has no entry.
- invented_seller_disclosure (blocking) — an entry's source_text is not a value the seller wrote.
- undisclosed_seller_issue (blocking) — an entry graded "defect" is marked "omitted".
- misgraded_seller_disclosure (blocking) — an entry that plainly describes something wrong with the item is graded other than "defect".

## Condition
- tier_contradicts_visible_damage (blocking) — tier is "Brand New" or "Like New" while the analysis reports visible damage.
- tier_contradicts_seller_issues (blocking) — tier is "Brand New" or "Like New" while a disclosure is graded "defect".

## Category
The taxonomy — the only valid category and subcategory pairs:
${TAXONOMY}
- subcategory_not_in_category (blocking) — the subcategory is not listed under the chosen category.
- category_corrected (warning) — the draft's category differs from where the seller filed it.
- subcategory_corrected (warning) — same category, but the seller's subcategory was changed.

## Description
- description_too_short (warning) — the description is too thin to tell a buyer anything useful.

Check every rule against every spec, correction and disclosure. Do not stop at the first problem.`;

/** The auditor's brief: the evidence, then the draft it is checked against. */
function checkBrief(context: RunContext): string {
  const { listing, analysis, lookups, draft } = context;
  return [
    `Listing ${listing.listing_id} — the seller filed it under ${listing.category}${listing.subcategory ? ` / ${listing.subcategory}` : ' (no subcategory)'}.`,
    `Asking price: ${listing.seller.price} INR.`,
    '',
    "Seller's submission:",
    JSON.stringify(listing.seller, null, 2),
    '',
    describeImages(context),
    '',
    'Image analysis:',
    analysis
      ? JSON.stringify(analysis, null, 2)
      : 'None — analyze_images was not run or had no image to read.',
    '',
    lookups.length
      ? `Product lookups run: ${JSON.stringify(lookups, null, 2)}`
      : 'Product lookups run: none.',
    '',
    'Draft to audit:',
    JSON.stringify(draft, null, 2),
  ].join('\n');
}

/**
 * Audits a draft against everything gathered for its listing.
 *
 * A model does the checking from the rules in `CHECK_SYSTEM`: whether a title
 * token is backed by a spec, or a seller value was overridden, is a question of
 * meaning that string matching kept getting wrong. It sees the analysis as
 * text, not the photos, so the call stays cheap enough to run on every
 * submission, and it runs on the verify model so it does not share the
 * drafter's blind spots.
 */
export async function checkDraft(
  context: RunContext,
  llm: LlmService,
  config: AgentConfig,
): Promise<Violation[]> {
  if (!context.draft) {
    return [
      { code: 'no_draft', severity: 'blocking', message: 'No draft to check.' },
    ];
  }

  const { object, usage } = await llm.generateObject({
    model: config.verify,
    system: CHECK_SYSTEM,
    schema: draftCheckSchema,
    schemaName: 'draft_check',
    temperature: 0,
    messages: [{ role: 'user', content: checkBrief(context) }],
  });
  recordUsage(context, usage);
  return object.violations;
}

export const hasBlocking = (violations: Violation[]) =>
  violations.some((violation) => violation.severity === 'blocking');

export const summarize = (violations: Violation[]) =>
  violations.length === 0
    ? 'No rule violations found.'
    : violations
        .map((v) => `[${v.severity}] ${v.code}: ${v.message}`)
        .join('\n');
