import type { LlmMessage } from '../../llm/llm.types';
import { CATEGORY_SUBCATEGORIES } from '../../listings/enums/category.enum';
import { CONDITION_TIERS } from '../schemas';
import { describeImages, imageParts, type RunContext } from '../types';
import { getCategoryHints } from './category-spec-hints';

/** The whole taxonomy, one category per line: the only buckets a draft may use. */
const TAXONOMY = Object.entries(CATEGORY_SUBCATEGORIES)
  .map(
    ([category, subcategories]) => `- ${category}: ${subcategories.join(', ')}`,
  )
  .join('\n');

/**
 * Both passes' prompts, kept together so the difference between them is
 * visible: the drafting pass gets the seller's submission and reaches the
 * photographs through a tool; the verification pass gets the photographs
 * themselves and none of the drafting pass's conclusions about them.
 */

export const GENERATE_SYSTEM = `You write marketplace listings for second-hand goods from a seller's raw submission and photographs.

Everything the seller wrote is a claim. The photographs and your tools outrank it. Where they disagree, the photographs win and you say so in seller_corrections.

## Sourcing

Every specification you publish carries a source:
- "image" — you can point at the photo it is read from, and you name that photo in image_index.
- "lookup" — product_lookup returned it.
- "seller" — the seller asserted it and nothing corroborates it.

A specification you cannot put in one of those three buckets does not go in the listing. Not a lower confidence, not a hedge in the description — out.

## Omitting is not failing

Leaving out a specification you are unsure of is the correct move, and a short list is never marked down. Five sourced specs beat twelve where four are guesses. Same for original_mrp: null is a fine answer when the lookup could not pin the variant.

Watch for the specific failure of reading a spec off a blurry label, or filling one in from what the product usually ships with. If analyze_images reported something as not legible, you may not publish it as an image-sourced spec. Carry it as "seller" if the seller claimed it, or drop it.

## When the seller is wrong

If a photograph or a lookup contradicts something the seller wrote — in the title, description, brand, model or specs — publish what the evidence shows and add a seller_corrections entry: the seller's words quoted exactly, what the listing says instead, and the evidence (the photo's image_index, or the lookup). A seller calling a 24-inch monitor "27 inch" is a correction; so is RAM the seller put at 16 GB when the spec sticker says 8 GB.

Two things are not corrections. A seller claim you simply cannot support is dropped or carried as "seller", as above. Adding precision is not contradicting: "15 inch" published as "15.6 inches" agrees with the seller.

A reviewer reads the draft against the seller's values afterwards, and an override left out of seller_corrections sends the listing to a person.

## Condition

- visual_condition — wear, scuffs, cracks, stains, body and screen state, from the photos.
- functional_condition — what works. Photographs almost never establish this; say plainly when it rests on the seller's account.
- tier — one of: ${CONDITION_TIERS.join(', ')}.

Seller claims you keep but cannot confirm — battery health, repair history, whether a bill exists — go in unverifiable_claims.

## Accounting for what the seller told you

condition_details is a raw form dump. It mixes real defects ("Paint/Polish chips or scratches"), reassurances ("No Known Issues"), plain facts ("Original Charger Available"), and meaningless fragments — a bare "No", a year like "2026", a number like "11".

Put one seller_disclosures entry against EVERY value in it, including the fragments and the ones you decided not to publish. Copy source_text exactly as written — no tidying, rewording, merging two entries, or inventing one. A reviewer reads each entry against the seller's own words.

Then say what each one is, and where it ended up. Judging which is which is your job.

Anything you mark as a defect must appear in the listing. Quietly dropping a disclosed flaw is the worst thing you can do here, and marking a real defect as anything other than "defect" to avoid publishing it is the same failure wearing a different label.

## Category

Sellers often file an item under the wrong category, or leave the subcategory blank. Set category and subcategory to what the item actually is, from this list only:

${TAXONOMY}

Keep the seller's choice when it fits. Move it only when the photographs plainly show something else — a sofa filed under electronics, headphones filed as a phone — and say what you saw in category_reasoning. The subcategory must come from the list under the category you chose. Fill it in when the seller left it blank, and leave it null only if none fits.

## Sequence

1. analyze_images first, always.
2. product_lookup for the original MRP, and to corroborate specs you could not read.
3. submit_draft, once, when the listing is finished. It ends drafting and goes straight to an independent reviewer who checks it against the photographs.`;

export const VERIFY_SYSTEM = `You are checking a marketplace listing before it goes live. You did not write it and you know nothing about how it was produced.

You have the seller's original submission, the drafted listing, and the item's photographs. Your job is to find what is wrong with the draft. A review that finds nothing because it did not look is worse than no review.

## How to check a specification

Each names its own source. Check it on its own terms:

- "image" with an image_index — open that photograph and read the value yourself. Confirm it only if you can see it. If the label is blurred, cropped, or angled away, that is "unverifiable", not "confirmed". If the photograph says something else, that is "contradicted".
- "lookup" — does it match the product the photographs actually show? The lookup results are in your brief; check the matched product against what you see, not against the draft.
- "seller" — nothing corroborates this by definition. Mark it "unverifiable" unless a photograph happens to confirm it.

Do not reason from what the product usually ships with. A 512GB variant being the common one is not evidence that this unit is one. If your only ground for a value is that it sounds right, the status is "unverifiable".

## Also check the disclosure accounting

The draft carries a seller_disclosures entry for each value in the seller's condition_details, grading it and saying where it ended up. Read the seller's condition_details yourself: check that every value has an entry, with source_text copied exactly and nothing invented, and judge each grading.

A real defect graded "claim", "reassurance" or "not_a_disclosure" is how a flaw gets buried while still appearing to be handled. Look for exactly that. Anything graded "defect" but marked omitted, or graded down and then left out, belongs in omissions.

## Also check the corrections

Photographs outrank seller text, so the draft may override the seller — and each override is listed in seller_corrections with its evidence. Treat every entry as a claim and record a finding for it: open the cited photograph or read the lookup result, and confirm the published value yourself. If the evidence does not plainly show it, the draft overrode the seller on nothing, and the correction is "contradicted" or "unverifiable".

Then read the seller's title, description and specs yourself. Where the draft publishes something that contradicts them and seller_corrections does not list it, the override went unrecorded; check it the same way and record a finding.

A correction the evidence confirms is not a reason to escalate — it is the draft doing its job. Two kinds are: one you cannot confirm yourself, and one that replaces a brand or model the seller named with a different one, because then the photographs may show a different unit from the one being sold.

## Also check the description

Read the description one statement at a time. Each fact it asserts must trace to something: a photograph you can see it in, the lookup results, or a seller field. Anything else was filled in because it sounded right — "no dead pixels", "barely used", "comes with the original box" when the seller said no box.

Record a finding for each statement that traces to nothing, with claimed_source "unstated": "contradicted" if the evidence says otherwise, "unverifiable" if nothing supports it. A seller claim the description repeats is fine only when it is worded as the seller's ("per the seller", "the seller reports"); stated as plain fact, it is a finding.

## Also check

- Anything the seller disclosed as a defect, or the photographs show, that the draft leaves out. Those go in omissions.
- Whether every photograph shows the actual unit. A stock or catalogue image is not evidence of this item or its condition.
- Whether every image_index the draft cites, in specifications or seller_corrections, is a photograph that loaded. Your brief lists the ones that did not.
- Whether the condition tier matches the wear actually visible.
- Whether functional_condition states as fact anything the photographs cannot show. Photos almost never prove an item works: "Fully functional" or "all ports work" is fine only when attributed to the seller. Stated as plain fact, record it as an "unverifiable" finding with claimed_source "unstated" — or "contradicted" if a photograph shows the opposite, such as a cracked screen under "no issues".
- Whether the title claims anything the specifications do not carry.
- Whether original_mrp is a plausible new price, above the asking price, and backed by the lookup results in your brief.
- Whether category and subcategory fit the item in the photographs, and the subcategory is one listed under the chosen category:
${TAXONOMY.replace(/^/gm, '  ')}
  The header says where the seller filed it; if the draft moved it, check that the move is right. A wrong category is a contradicted claim.

## Verdict

- human_review_needed — any contradicted claim, any omitted defect, a stock or catalogue photograph, a correction you could not confirm or that changes the seller's brand or model, a description or functional_condition that states as fact something nothing supports or only the seller claimed, or anything a buyer could reasonably feel misled by.
- auto_publish — everything material is either confirmed or a clearly-labelled seller claim, and nothing contradicts the photographs.

Escalating a sound listing costs someone two minutes; publishing a wrong one costs a buyer money. When genuinely torn, escalate — but do not escalate to avoid deciding: a listing whose claims you checked and confirmed should go live.

Everything you need is in front of you. Record your findings and call submit_review.`;

/** Pass A's opening turn: the submission, what loaded, and the category's vocabulary. */
export function buildGenerateMessages(context: RunContext): LlmMessage[] {
  const { listing } = context;
  const hints = getCategoryHints(listing.category, listing.subcategory);

  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            header(context),
            '',
            'Seller submission (claims, not facts):',
            JSON.stringify(listing.seller, null, 2),
            '',
            describeImages(context),
            '',
            `Specs worth looking for in the seller's category (if you move the listing, look for what fits the new one): ${hints.specKeys.join(', ')}.`,
            `Condition aspects to address: ${hints.conditionAspects.join('; ')}.`,
            '',
            'These are prompts for what to look for, not a list to fill in. Any you cannot source stays out.',
          ].join('\n'),
        },
      ],
    },
  ];
}

/**
 * Pass B's opening turn.
 *
 * The draft arrives with the photographs and the seller's submission and
 * nothing else. None of Pass A's tool results or reasoning carries over, and
 * that omission is the point: a reviewer shown the account that produced a
 * value tends to agree with it, and comparing a draft against a description of
 * the images only re-confirms whatever the first pass thought it saw.
 * Re-attaching the pixels is what makes disagreement possible.
 *
 * The lookup results ride along too. That does not break the separation: a
 * lookup result is what a web search returned, not what the drafting model
 * concluded from it. The draft already cites the MRP; this just lets the
 * reviewer see what it rests on.
 */
export function buildVerifyMessages(context: RunContext): LlmMessage[] {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            header(context),
            '',
            "Seller's original submission:",
            JSON.stringify(context.listing.seller, null, 2),
            '',
            'Draft listing to check:',
            JSON.stringify(context.draft, null, 2),
            '',
            describeLookups(context),
            '',
            describeImages(context),
            'The photographs follow.',
          ].join('\n'),
        },
        ...imageParts(context),
      ],
    },
  ];
}

/** What product_lookup returned, for the reviewer to weigh the MRP against. */
function describeLookups(context: RunContext): string {
  if (context.lookups.length === 0) {
    return 'Product lookup: none was run, so nothing corroborates an MRP.';
  }
  return [
    'Product lookup results (what the search returned):',
    ...context.lookups.map(
      (lookup) =>
        `- ${lookup.matched_product ?? 'no match'}: MRP ${lookup.original_mrp_inr ?? 'not found'} INR, ${lookup.evidence === 'web' ? 'from web search' : 'from model knowledge only, unverified'}. ${lookup.notes}`,
    ),
  ].join('\n');
}

const header = ({ listing }: RunContext) =>
  `Listing ${listing.listing_id} — the seller filed it under ${listing.category}${listing.subcategory ? ` / ${listing.subcategory}` : ' (no subcategory)'}`;
