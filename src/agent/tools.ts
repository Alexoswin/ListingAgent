import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { LlmService } from '../llm/llm.service';
import type { AgentConfig } from './agent.config';
import { checkDraft, hasBlocking, summarize } from './draft-checker';
import {
  imageAnalysisSchema,
  pdpSchema,
  productLookupSchema,
  reviewSchema,
} from './schemas';
import type { AgentTool } from './tool-loop';
import { imageParts, usableImages, type RunContext } from './types';
import { webSearch } from './web-search';

export interface ToolDeps {
  llm: LlmService;
  config: AgentConfig;
  context: RunContext;
}

/** After this many rejected drafts, keep what there is and let review sort it out. */
const MAX_DRAFT_ATTEMPTS = 3;

const listingIdArg = z.strictObject({
  listing_id: z.string().describe('The listing being processed.'),
});

const logger = new Logger('AgentTools');

/** Tool arguments arrive as `unknown`; take a string or nothing. */
const asText = (value: unknown) =>
  typeof value === 'string' ? value.trim() : '';

const ANALYZE_SYSTEM = `You are examining photographs of a second-hand item for a marketplace.

Report only what is actually visible. A system downstream will refuse any specification you cannot point at, so an honest "cannot read this" is worth more than a confident guess.

- Set legible: false whenever text is blurred, glared, cropped, angled, or too small to read with certainty. Do not infer the likely value from the product's usual configuration — that is the one thing this step must never do.
- Report what the pixels show, not what the product typically ships with.
- Flag catalogue renders: even lighting, seamless background, no wear, showroom angle.
- Note every scuff, scratch, dent, crack, stain, or missing part you can see.`;

const LOOKUP_SYSTEM = `You identify consumer products and their original list price.

Return the price the product sold for NEW at launch, in INR, for the Indian market where you can tell. Never a resale, refurbished, or discounted price.

If the model string covers several variants at different prices and you cannot tell which this is, return null for the price and explain the ambiguity. Null is the correct answer whenever the evidence does not single out one variant.`;

/**
 * Reads the listing's images.
 *
 * The URLs were fetched and validated before the agent started, so this spends
 * its vision call on images that exist. The result is cached on the context:
 * the drafting model often asks twice, and the photos do not change.
 */
export const analyzeImagesTool = (deps: ToolDeps): AgentTool => ({
  spec: {
    name: 'analyze_images',
    description:
      "Look at the listing's photographs and report what is visible: brand and model markings, readable specs, damage, accessories, and whether any image is a stock photo. Call this before drafting.",
    parameters: listingIdArg,
  },
  async execute() {
    const { context, config, llm } = deps;
    if (context.analysis) {
      return { done: false, result: JSON.stringify(context.analysis) };
    }
    if (usableImages(context).length === 0) {
      return {
        done: false,
        result:
          'No image loaded for this listing. Nothing can be verified visually; say so in the draft and keep the specifications to what the seller claims.',
      };
    }

    const { seller, category, subcategory } = context.listing;
    const { object, usage } = await llm.generateObject({
      ...config.generate,
      system: ANALYZE_SYSTEM,
      schema: imageAnalysisSchema,
      schemaName: 'image_analysis',
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `Category: ${category}${subcategory ? ` / ${subcategory}` : ''}`,
                `The seller says this is: ${[seller.brand, seller.model].filter(Boolean).join(' ') || 'unspecified'}`,
                '',
                'Treat that as a claim to check, not a description to confirm. Report what you see.',
              ].join('\n'),
            },
            ...imageParts(context),
          ],
        },
      ],
    });

    context.usage.inputTokens += usage.inputTokens;
    context.usage.outputTokens += usage.outputTokens;
    context.analysis = object;
    return { done: false, result: JSON.stringify(object) };
  },
});

/**
 * Looks up a product's canonical specs and its original MRP.
 *
 * MRP is the one required field no photograph can supply — the seller's
 * `original_price` is blank across the dataset — so this is the only route to
 * it. Without a search key it still answers from the model's own knowledge, but
 * marks the result so the draft has to label the price unverified.
 */
export const productLookupTool = (deps: ToolDeps): AgentTool => ({
  spec: {
    name: 'product_lookup',
    description:
      "Find a product's original list price when new (MRP) and its manufacturer specifications. Use it for the MRP, and to corroborate specs you could not read off the photos.",
    parameters: z.strictObject({
      brand: z.string().describe('Brand name, e.g. "ASUS".'),
      model: z.string().describe('Model as precisely as you know it.'),
      category: z
        .string()
        .describe('What kind of product, e.g. "gaming laptop".'),
    }),
  },
  async execute(args) {
    const { context, config, llm } = deps;
    const brand = asText(args.brand);
    const model = asText(args.model);
    const category = asText(args.category);

    if (!brand && !model) {
      return {
        done: false,
        result:
          'Nothing to look up: no brand or model given. If neither is known, leave original_mrp null.',
      };
    }

    const results = await webSearch(
      config.search,
      `${brand} ${model} ${category} original launch price India specifications`.trim(),
    );
    const evidence = results.length
      ? ('web' as const)
      : ('model_knowledge' as const);

    const { object, usage } = await llm.generateObject({
      ...config.generate,
      system: LOOKUP_SYSTEM,
      schema: productLookupSchema,
      schemaName: 'product_lookup',
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `Identify: ${brand} ${model} (${category})`,
                '',
                ...(results.length
                  ? [
                      'Search results:',
                      ...results.map(
                        (r, i) =>
                          `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`,
                      ),
                      '',
                      'Use these. Do not add specifications they do not support.',
                    ]
                  : [
                      'No search results are available, so answer from your own knowledge and be conservative: return null rather than a half-remembered price.',
                    ]),
              ].join('\n'),
            },
            // The photos help pin the variant when the model string is vague,
            // which is most of this dataset ("7420 7 series i7 11 generation").
            ...imageParts(context),
          ],
        },
      ],
    });

    context.usage.inputTokens += usage.inputTokens;
    context.usage.outputTokens += usage.outputTokens;
    context.lookups.push({ ...object, evidence });

    return {
      done: false,
      result: JSON.stringify({
        ...object,
        sources: results.map((result) => result.url),
        cite_as: evidence === 'web' ? 'lookup_web' : 'lookup_model_knowledge',
      }),
    };
  },
});

/**
 * The only exit from the generation pass, and where the rule checks run.
 *
 * Validation lives here rather than in a tool the model may call, for two
 * reasons: a model that can skip its own check eventually does, and asking it
 * to pass a draft to a checker and then the same draft to a submitter means
 * writing the whole thing out twice. A rejected draft comes back as violations,
 * so the pass self-corrects before review ever sees it.
 */
export function submitDraftTool(deps: ToolDeps): AgentTool {
  let attempts = 0;

  return {
    spec: {
      name: 'submit_draft',
      description:
        'Submit the finished listing. It is checked against the images and the seller submission before it is accepted; if it comes back with problems, fix them and submit again.',
      parameters: pdpSchema,
    },
    execute(args) {
      const { context } = deps;
      const parsed = pdpSchema.safeParse(args);
      if (!parsed.success) {
        return {
          done: false,
          result: `Draft rejected — wrong shape:\n${issues(parsed.error)}`,
        };
      }

      attempts++;
      context.draft = parsed.data;
      context.violations = checkDraft(context);

      if (!hasBlocking(context.violations)) {
        return {
          done: true,
          result: `Draft accepted.\n${summarize(context.violations)}`,
        };
      }
      if (attempts >= MAX_DRAFT_ATTEMPTS) {
        // Keep the draft and let verification see it with its violations
        // attached — an escalated listing beats a failed one.
        logger.warn(
          `Listing ${context.listing.listing_id}: still blocking after ${attempts} attempts, escalating`,
        );
        return {
          done: true,
          result: 'Draft kept with unresolved problems; it will be escalated.',
        };
      }

      return {
        done: false,
        result: [
          'Draft rejected. Fix every blocking problem and submit again.',
          '',
          summarize(context.violations),
          '',
          'Dropping an unsupportable specification is a valid fix. So is lowering the condition tier, or leaving original_mrp null.',
        ].join('\n'),
      };
    },
  };
}

/**
 * Runs the rule checks over the draft under review. Takes an id, not the draft:
 * making the reviewer retype the object it is auditing invites exactly the
 * transcription drift an audit exists to catch.
 */
export const checkDraftTool = (deps: ToolDeps): AgentTool => ({
  spec: {
    name: 'check_draft',
    description:
      'Run the automated rule checks over the draft you are reviewing: sourcing, price arithmetic, tier consistency, and dropped seller disclosures.',
    parameters: listingIdArg,
  },
  execute() {
    deps.context.violations = checkDraft(deps.context);
    return { done: false, result: summarize(deps.context.violations) };
  },
});

/** The verification pass's only exit. */
export const submitReviewTool = (deps: ToolDeps): AgentTool => ({
  spec: {
    name: 'submit_review',
    description:
      'Submit your verification result: per-claim findings, any omissions, and the verdict.',
    parameters: reviewSchema,
  },
  execute(args) {
    const parsed = reviewSchema.safeParse(args);
    if (!parsed.success) {
      return {
        done: false,
        result: `Review rejected — wrong shape:\n${issues(parsed.error)}`,
      };
    }
    deps.context.review = parsed.data;
    return { done: true, result: 'Review recorded.' };
  },
});

const issues = (error: z.ZodError) =>
  error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
