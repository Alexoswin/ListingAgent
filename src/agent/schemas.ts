import { z } from 'zod';

/**
 * Every schema the agent uses, for both structured output and tool arguments.
 *
 * Field names are snake_case because these objects are written straight to
 * `output/results.json` — they are a wire format, like a DTO.
 *
 * One constraint shapes what can appear here, from OpenAI's strict
 * structured-output mode: every declared key must be present, so optional
 * fields use `.nullable()` rather than `.optional()`.
 */

export const SPEC_SOURCES = ['image', 'lookup', 'seller'] as const;
export const CONDITION_TIERS = [
  'Brand New',
  'Like New',
  'Lightly Used',
  'Regularly Used',
  'Needs Repair',
] as const;
export const VERDICTS = ['auto_publish', 'human_review_needed'] as const;

/**
 * How a line in the seller's `condition_details` reads.
 *
 * Deciding which of these applies is language comprehension, so the model does
 * it. The checker only verifies that every line got one — see `draft-checker`.
 */
export const SELLER_DISCLOSURE_KINDS = [
  'defect',
  'reassurance',
  'claim',
  'not_a_disclosure',
] as const;

export type Verdict = (typeof VERDICTS)[number];

/** What the vision call returns for one listing's images. */
export const imageAnalysisSchema = z.strictObject({
  images: z.array(
    z.strictObject({
      index: z.number().int().describe('Position in the list you were given.'),
      shows_product: z
        .boolean()
        .describe('False for receipts, unrelated screenshots, filler.'),
      looks_like_stock_photo: z
        .boolean()
        .describe('True for a catalogue render rather than the actual unit.'),
      notes: z.string().describe('Angle, lighting, blur, what is in frame.'),
    }),
  ),
  observed_brand: z
    .string()
    .nullable()
    .describe('Brand visible on the product itself. Null if not visible.'),
  observed_model_text: z
    .string()
    .nullable()
    .describe('Model text on a label, badge, or screen. Null if not visible.'),
  observations: z.array(
    z.strictObject({
      attribute: z.string().describe('e.g. "RAM", "Screen condition".'),
      value: z.string().describe('What you can actually see.'),
      image_index: z.number().int().describe('Which image shows it.'),
      legible: z
        .boolean()
        .describe(
          'False when the detail is too small, blurred, glared, or cropped to read with certainty. Set it false rather than guessing.',
        ),
    }),
  ),
  visible_damage: z
    .array(z.string())
    .describe('Scuffs, cracks, dents, stains, missing parts you can see.'),
  visible_accessories: z
    .array(z.string())
    .describe('Chargers, boxes, remotes visible in the photos.'),
  summary: z.string(),
});

/** What `product_lookup` extracts from search results, or from memory. */
export const productLookupSchema = z.strictObject({
  matched_product: z
    .string()
    .nullable()
    .describe('The product you believe this is. Null if you cannot tell.'),
  original_mrp_inr: z
    .number()
    .nullable()
    .describe('Launch price when new, in INR. Null if not found.'),
  specifications: z.array(
    z.strictObject({ key: z.string(), value: z.string() }),
  ),
  notes: z
    .string()
    .describe('Caveats: variant ambiguity, price range, region differences.'),
});

/** The generated product page, and the arguments to `submit_draft`. */
export const pdpSchema = z.strictObject({
  title: z
    .string()
    .describe('Only mention attributes that also appear in specifications.'),
  description: z
    .string()
    .describe(
      'State what is known and what could not be verified. Never fill gaps with plausible detail.',
    ),
  original_mrp: z
    .number()
    .nullable()
    .describe(
      "The product's list price when new, in INR, from product_lookup. Never the asking price. Null if no reasonable value was found.",
    ),
  original_mrp_source: z
    .enum(['lookup_web', 'lookup_model_knowledge', 'none'])
    .describe('Use "none" when original_mrp is null.'),
  specifications: z.array(
    z.strictObject({
      key: z.string().describe('Spec name, e.g. "RAM", "Seater Count".'),
      value: z.string(),
      source: z
        .enum(SPEC_SOURCES)
        .describe(
          '"image" = read off a photo; "lookup" = from product_lookup; "seller" = the seller\'s claim, uncorroborated.',
        ),
      image_index: z
        .number()
        .int()
        .nullable()
        .describe('Required when source is "image". Null otherwise.'),
      confidence: z.number().describe('0 to 1, for this exact value.'),
    }),
  ),
  condition: z.strictObject({
    tier: z.enum(CONDITION_TIERS),
    visual_condition: z.string().describe('What the photos show.'),
    functional_condition: z
      .string()
      .describe(
        'What works. Say plainly when function cannot be judged from photos.',
      ),
    reasoning: z.string().describe('Why this tier and not the adjacent ones.'),
  }),
  unverifiable_claims: z
    .array(z.string())
    .describe(
      'Seller claims kept in the listing that nothing could confirm (battery health, repair history, bill availability).',
    ),
  seller_disclosures: z
    .array(
      z.strictObject({
        source_text: z
          .string()
          .describe(
            'One entry from condition_details, copied character for character. It is matched exactly against the input, so do not tidy, reword, or merge entries.',
          ),
        kind: z
          .enum(SELLER_DISCLOSURE_KINDS)
          .describe(
            '"defect" = something is wrong with the item. "reassurance" = an explicit statement that nothing is wrong. "claim" = a factual statement that is not a defect (battery health, what is included, warranty). "not_a_disclosure" = a form fragment that carries no meaning on its own, like a bare "No", a year, or a number.',
          ),
        addressed_in: z
          .enum(['description', 'condition', 'unverifiable_claims', 'omitted'])
          .describe('Where this ends up in the listing, or "omitted".'),
      }),
    )
    .describe(
      "One entry for EVERY value in the seller's condition_details, including the ones you decided not to publish. This is checked against the input for completeness, so a missing entry fails.",
    ),
});

/**
 * The verification result, and the arguments to `submit_review`.
 *
 * `findings` is declared before `verdict` on purpose: generation runs left to
 * right, so the model commits to per-claim evidence before it names a verdict.
 * Asking for the verdict first gets a verdict followed by whatever reasoning
 * justifies it.
 */
export const reviewSchema = z.strictObject({
  findings: z.array(
    z.strictObject({
      claim: z.string().describe('The specific thing you checked.'),
      claimed_source: z.enum([...SPEC_SOURCES, 'unstated']),
      status: z
        .enum(['confirmed', 'contradicted', 'unverifiable'])
        .describe(
          '"confirmed" = you saw it yourself. "contradicted" = the evidence says otherwise. "unverifiable" = the evidence cannot settle it.',
        ),
      note: z.string(),
    }),
  ),
  omissions: z
    .array(z.string())
    .describe(
      'Defects the seller disclosed, or the images show, that the draft leaves out.',
    ),
  verdict: z.enum(VERDICTS),
  notes: z.string().describe('Short rationale for the verdict.'),
});

export type ImageAnalysis = z.infer<typeof imageAnalysisSchema>;
export type ProductLookup = z.infer<typeof productLookupSchema>;
export type GeneratedPdp = z.infer<typeof pdpSchema>;
export type AgentReview = z.infer<typeof reviewSchema>;
