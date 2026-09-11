import type { JsonValue } from '../common/types/json-value';
import { CATEGORY_SUBCATEGORIES } from '../listings/enums/category.enum';
import type { RunContext, Violation } from './types';
import { usableImages } from './types';

/**
 * Spec-shaped tokens in a title, e.g. "16GB", "14 inch", "3 seater".
 *
 * This stays a pattern in code rather than a model judgement because it is
 * tokenisation, not comprehension — and its failure mode is safe: a unit the
 * pattern misses costs one catch, it never invents a violation. The reviewing
 * pass checks the title against the specifications as well.
 */
const SPEC_TOKEN =
  /\b\d+(?:\.\d+)?\s?(gb|tb|mb|inch|"|l|litre|litres|liter|liters|seater|ghz|mp|watt|w|kg|ft)\b/gi;

const flat = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const overlaps = (a: string, b: string) =>
  flat(a).includes(flat(b)) || flat(b).includes(flat(a));

const categoryLabel = (category: string, subcategory?: string | null) =>
  subcategory ? `${category} / ${subcategory}` : category;

/**
 * Checks a draft against everything gathered for its listing.
 *
 * Every rule is arithmetic or string comparison — no model, no judgement. That
 * is the point: these cannot fail the same way twice, so they still hold when a
 * misleading photo fools both passes into agreeing with each other.
 */
export function checkDraft(context: RunContext): Violation[] {
  const { listing, draft, analysis } = context;
  const violations: Violation[] = [];
  const add = (
    code: string,
    severity: Violation['severity'],
    message: string,
  ) => violations.push({ code, severity, message });

  if (!draft) {
    add('no_draft', 'blocking', 'No draft to check.');
    return violations;
  }

  const usable = usableImages(context);
  const usableIndexes = new Set(usable.map((image) => image.index));

  // Evidence base ---------------------------------------------------------
  if (usable.length === 0) {
    add(
      'no_usable_images',
      'blocking',
      'No image loaded, so nothing could be checked against a photo.',
    );
  }

  const stock = (analysis?.images ?? []).filter(
    (i) => i.looks_like_stock_photo,
  );
  if (stock.length) {
    add(
      'stock_photo',
      'blocking',
      `Image(s) ${stock.map((i) => i.index).join(', ')} look like catalogue renders, not the actual unit.`,
    );
  }

  // Specifications --------------------------------------------------------
  if (draft.specifications.length === 0) {
    add(
      'no_specifications',
      'blocking',
      'Draft carries no specifications at all.',
    );
  }

  for (const spec of draft.specifications) {
    if (spec.confidence < 0.4) {
      add(
        'low_confidence_spec',
        'warning',
        `"${spec.key}" carries confidence ${spec.confidence}.`,
      );
    }
    if (spec.source !== 'image') {
      continue;
    }
    if (spec.image_index === null) {
      add(
        'image_spec_without_index',
        'blocking',
        `"${spec.key}" claims an image source but names no image.`,
      );
    } else if (!usableIndexes.has(spec.image_index)) {
      add(
        'spec_cites_unusable_image',
        'blocking',
        `"${spec.key}" cites image ${spec.image_index}, which did not load.`,
      );
    } else {
      // A spec read off a photo must trace to something the vision pass
      // actually reported, and reported as readable.
      const seen = analysis?.observations.find(
        (o) => overlaps(o.attribute, spec.key) || overlaps(o.value, spec.value),
      );
      if (seen && !seen.legible) {
        add(
          'spec_from_illegible_evidence',
          'blocking',
          `"${spec.key}" is read off image ${spec.image_index}, but that detail was reported illegible.`,
        );
      } else if (!seen) {
        add(
          'spec_not_corroborated_by_analysis',
          'warning',
          `"${spec.key}" claims image ${spec.image_index}, but the image analysis never reported it.`,
        );
      }
    }
  }

  const specText = flat(
    draft.specifications.map((s) => `${s.key} ${s.value}`).join(' '),
  );
  for (const token of draft.title.match(SPEC_TOKEN) ?? []) {
    if (!specText.includes(flat(token))) {
      add(
        'title_claims_unlisted_spec',
        'blocking',
        `Title advertises "${token.trim()}", which is in no specification.`,
      );
    }
  }

  // Original MRP ----------------------------------------------------------
  if (draft.original_mrp !== null) {
    if (draft.original_mrp_source === 'none') {
      add(
        'mrp_without_source',
        'blocking',
        'An original MRP is given but no source is claimed for it.',
      );
    }
    if (draft.original_mrp <= listing.seller.price) {
      add(
        'mrp_not_above_price',
        'blocking',
        `Original MRP ${draft.original_mrp} is not above the asking price ${listing.seller.price}.`,
      );
    }
    if (draft.original_mrp_source === 'lookup_model_knowledge') {
      add(
        'mrp_from_model_knowledge',
        'warning',
        'Original MRP came from model knowledge, not a web result.',
      );
    }
  }

  // Seller disclosures ------------------------------------------------------
  // Whether a line reads as a defect is language, so the model grades it. What
  // is checked here is bookkeeping: every line present in the input must be
  // accounted for, and nothing may be accounted for that was never there. Both
  // are exact string comparisons against `condition_details`, so no phrasing
  // slips past and no wording can be invented to satisfy the check.
  const written = sellerDisclosures(listing.seller.condition_details);
  const accountedFor = new Set(
    draft.seller_disclosures.map((entry) => entry.source_text.trim()),
  );

  for (const text of written) {
    if (!accountedFor.has(text)) {
      add(
        'unaccounted_seller_disclosure',
        'blocking',
        `Seller wrote "${text}" and the draft never accounts for it.`,
      );
    }
  }

  const writtenSet = new Set(written);
  for (const entry of draft.seller_disclosures) {
    if (!writtenSet.has(entry.source_text.trim())) {
      add(
        'invented_seller_disclosure',
        'blocking',
        `Draft accounts for "${entry.source_text}", which the seller never wrote.`,
      );
    }
  }

  const defects = draft.seller_disclosures.filter(
    (entry) => entry.kind === 'defect',
  );
  for (const defect of defects) {
    if (defect.addressed_in === 'omitted') {
      add(
        'undisclosed_seller_issue',
        'blocking',
        `Seller disclosed "${defect.source_text}" as a defect and the listing leaves it out.`,
      );
    }
  }

  // Condition ---------------------------------------------------------------
  const damage = analysis?.visible_damage ?? [];
  const pristine =
    draft.condition.tier === 'Brand New' || draft.condition.tier === 'Like New';

  if (pristine && damage.length) {
    add(
      'tier_contradicts_visible_damage',
      'blocking',
      `Tier "${draft.condition.tier}" against visible damage: ${damage.join('; ')}.`,
    );
  }
  if (pristine && defects.length) {
    add(
      'tier_contradicts_seller_issues',
      'blocking',
      `Tier "${draft.condition.tier}" against disclosed defects: ${defects.map((d) => d.source_text).join('; ')}.`,
    );
  }

  // Category ----------------------------------------------------------------
  // Which category an item belongs in is the model's call. These only keep the
  // answer inside the taxonomy and make a move visible, so a reclassification
  // is never silent; the reviewing pass checks the move against the photos.
  if (
    draft.subcategory &&
    !CATEGORY_SUBCATEGORIES[draft.category].includes(draft.subcategory)
  ) {
    add(
      'subcategory_not_in_category',
      'blocking',
      `"${draft.subcategory}" is not a subcategory of ${draft.category}.`,
    );
  }
  if (draft.category !== listing.category) {
    add(
      'category_corrected',
      'warning',
      `Seller filed this under ${categoryLabel(listing.category, listing.subcategory)}; the draft moves it to ${categoryLabel(draft.category, draft.subcategory)}.`,
    );
  } else if (listing.subcategory && draft.subcategory !== listing.subcategory) {
    add(
      'subcategory_corrected',
      'warning',
      `Seller chose ${listing.subcategory}; the draft uses ${draft.subcategory ?? 'no subcategory'}.`,
    );
  }

  // Identity --------------------------------------------------------------
  const { observed_brand: observed } = analysis ?? {};
  const claimed = listing.seller.brand;
  if (observed && claimed && !overlaps(observed, claimed)) {
    add(
      'brand_mismatch',
      'blocking',
      `Images show "${observed}" but the seller claims "${claimed}".`,
    );
  }

  if (draft.description.trim().length < 80) {
    add(
      'description_too_short',
      'warning',
      'Description is too short to tell a buyer anything useful.',
    );
  }

  return violations;
}

export const hasBlocking = (violations: Violation[]) =>
  violations.some((violation) => violation.severity === 'blocking');

export const summarize = (violations: Violation[]) =>
  violations.length === 0
    ? 'No rule violations found.'
    : violations
        .map((v) => `[${v.severity}] ${v.code}: ${v.message}`)
        .join('\n');

/** Every non-empty string the seller wrote, wherever it sits in the record. */
function sellerDisclosures(details: Record<string, JsonValue>): string[] {
  const lines: string[] = [];
  const collect = (value: JsonValue) => {
    if (typeof value === 'string' && value.trim()) lines.push(value.trim());
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object')
      Object.values(value).forEach(collect);
  };
  Object.values(details ?? {}).forEach(collect);
  return lines;
}
