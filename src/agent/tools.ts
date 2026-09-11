import { Logger } from '@nestjs/common';
import { tool } from '@openai/agents';
import { z } from 'zod';
import type { LlmService } from '../llm/llm.service';
import type { LlmWebSearchResponse } from '../llm/llm.types';
import type { AgentConfig } from './agent.config';
import { checkDraft, hasBlocking, summarize } from './draft-checker';
import {
  imageAnalysisSchema,
  pdpSchema,
  productLookupSchema,
  reviewSchema,
  type ProductLookup,
} from './schemas';
import {
  imageParts,
  usableImages,
  type RunContext,
  type Violation,
} from './types';

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

/** Log prefix: which listing, which tool. */
const tag = (context: RunContext, tool: string) =>
  `${context.listing.listing_id} ${tool}`;

/** Violation codes at one severity, for log lines. */
const codesOf = (violations: Violation[], severity: Violation['severity']) =>
  violations
    .filter((violation) => violation.severity === severity)
    .map((violation) => violation.code);

/**
 * Logs a failed model call, then rethrows it. The Agents SDK catches a tool's
 * error and hands the model a generic message, so without this a failed vision
 * or lookup call would leave no trace in the logs.
 */
async function logFailure<T>(step: string, pending: Promise<T>): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    logger.error(
      `${step}: failed: ${(error as Error).message}`,
      (error as Error).stack,
    );
    throw error;
  }
}

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
export const analyzeImagesTool = (deps: ToolDeps) =>
  tool({
    name: 'analyze_images',
    description:
      "Look at the listing's photographs and report what is visible: brand and model markings, readable specs, damage, accessories, and whether any image is a stock photo. Call this before drafting.",
    parameters: listingIdArg,
    async execute() {
      const { context, config, llm } = deps;
      const step = tag(context, 'analyze_images');
      if (context.analysis) {
        logger.log(`${step}: reused the cached analysis`);
        return JSON.stringify(context.analysis);
      }
      const images = usableImages(context).length;
      if (images === 0) {
        logger.warn(`${step}: no usable image, nothing to analyse`);
        return 'No image loaded for this listing. Nothing can be verified visually; say so in the draft and keep the specifications to what the seller claims.';
      }

      logger.log(`${step}: reading ${images} image(s)`);
      const { seller, category, subcategory } = context.listing;
      const { object, usage } = await logFailure(
        step,
        llm.generateObject({
          model: config.generate, // default gpt-4.1-mini used
          system: ANALYZE_SYSTEM,
          schema: imageAnalysisSchema,
          schemaName: 'image_analysis',
          temperature: 0, //Verification tasks need consistency, not creativity. A low temperature reduces variation in wording and makes the model less likely to speculate about uncertain visual details.
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
        }),
      );

      context.usage.inputTokens += usage.inputTokens;
      context.usage.outputTokens += usage.outputTokens;
      context.analysis = object;
      logger.log(
        `${step}: done — brand ${object.observed_brand ?? 'not visible'}, ${object.observations.length} observation(s), ${object.visible_damage.length} damage note(s)`,
      );
      return JSON.stringify(object);
    },
  });

/**
 * Looks up a product's canonical specs and its original MRP.
 *
 * MRP is the one required field no photograph can supply — the seller's
 * `original_price` is blank across the dataset — so this is the only route to
 * it. It searches with OpenAI's hosted web search. If the search fails or finds
 * nothing, it answers from the model's own knowledge instead, and marks the
 * result so the draft has to label the price unverified.
 */
export const productLookupTool = (deps: ToolDeps) =>
  tool({
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
    async execute(args) {
      const { context, config, llm } = deps;
      const brand = asText(args.brand);
      const model = asText(args.model);
      const category = asText(args.category);

      const step = tag(context, 'product_lookup');
      if (!brand && !model) {
        logger.warn(`${step}: no brand or model given, nothing to look up`);
        return 'Nothing to look up: no brand or model given. If neither is known, leave original_mrp null.';
      }

      const request = (instruction: string) => ({
        model: config.generate,
        system: LOOKUP_SYSTEM,
        schema: productLookupSchema,
        schemaName: 'product_lookup',
        temperature: 0,
        messages: [
          {
            role: 'user' as const,
            content: [
              {
                type: 'text' as const,
                text: `Identify: ${brand} ${model} (${category})\n\n${instruction}`,
              },
              // The photos help pin the variant when the model string is vague,
              // which is most of this dataset ("7420 7 series i7 11 generation").
              ...imageParts(context),
            ],
          },
        ],
      });

      logger.log(
        `${step}: searching the web for "${[brand, model].filter(Boolean).join(' ')}"`,
      );
      let lookup: LlmWebSearchResponse<ProductLookup>;
      try {
        lookup = await llm.generateObjectWithWebSearch({
          ...request(
            'Search the web for its original launch price in India and its manufacturer specifications. Use only what the search results support; do not add specifications they do not mention.',
          ),
          searchCountry: 'IN',
        });
      } catch (error) {
        logger.error(
          `${step}: web search failed, falling back to model knowledge: ${(error as Error).message}`,
          (error as Error).stack,
        );
        lookup = {
          ...(await logFailure(
            `${step} (fallback)`,
            llm.generateObject(
              request(
                'No search results are available, so answer from your own knowledge and be conservative: return null rather than a half-remembered price.',
              ),
            ),
          )),
          sources: [],
        };
      }

      const { object, usage, sources } = lookup;
      // A search that came back empty grounded nothing, whatever the answer says.
      const evidence = sources.length
        ? ('web' as const)
        : ('model_knowledge' as const);

      context.usage.inputTokens += usage.inputTokens;
      context.usage.outputTokens += usage.outputTokens;
      context.lookups.push({ ...object, evidence });

      const found = `${object.matched_product ?? 'no match'}, MRP ${object.original_mrp_inr ?? 'not found'}`;
      if (evidence === 'web') {
        logger.log(
          `${step}: done — ${found}, from ${sources.length} web source(s)`,
        );
      } else {
        logger.warn(
          `${step}: done — ${found}, from model knowledge only (unverified)`,
        );
      }

      return JSON.stringify({
        ...object,
        // A search can return dozens of URLs; the draft only needs a few.
        sources: sources.slice(0, 5),
        cite_as: evidence === 'web' ? 'lookup_web' : 'lookup_model_knowledge',
      });
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
export function submitDraftTool(deps: ToolDeps) {
  let attempts = 0;

  return tool({
    name: 'submit_draft',
    description:
      'Submit the finished listing. It is checked against the images and the seller submission before it is accepted; if it comes back with problems, fix them and submit again.',
    parameters: pdpSchema,
    execute(args) {
      const { context } = deps;
      const step = tag(context, 'submit_draft');
      const parsed = pdpSchema.safeParse(args);
      if (!parsed.success) {
        logger.warn(
          `${step}: rejected, wrong shape (${parsed.error.issues.length} issue(s))`,
        );
        return `Draft rejected — wrong shape:\n${issues(parsed.error)}`;
      }

      attempts++;
      context.draft = parsed.data;
      context.violations = checkDraft(context);
      const blocking = codesOf(context.violations, 'blocking');
      const warnings = codesOf(context.violations, 'warning');

      if (!hasBlocking(context.violations)) {
        context.finished = true;
        logger.log(
          `${step}: accepted on attempt ${attempts}${warnings.length ? `, warnings: ${warnings.join(', ')}` : ''}`,
        );
        return `Draft accepted.\n${summarize(context.violations)}`;
      }
      if (attempts >= MAX_DRAFT_ATTEMPTS) {
        // Keep the draft and let verification see it with its violations
        // attached — an escalated listing beats a failed one.
        logger.error(
          `${step}: still blocking after ${attempts} attempts (${blocking.join(', ')}), escalating`,
        );
        context.finished = true;
        return 'Draft kept with unresolved problems; it will be escalated.';
      }

      logger.warn(
        `${step}: attempt ${attempts} rejected — ${blocking.join(', ')}`,
      );
      return [
        'Draft rejected. Fix every blocking problem and submit again.',
        '',
        summarize(context.violations),
        '',
        'Dropping an unsupportable specification is a valid fix. So is lowering the condition tier, or leaving original_mrp null.',
      ].join('\n');
    },
  });
}

/**
 * Runs the rule checks over the draft under review. Takes an id, not the draft:
 * making the reviewer retype the object it is auditing invites exactly the
 * transcription drift an audit exists to catch.
 */
export const checkDraftTool = (deps: ToolDeps) =>
  tool({
    name: 'check_draft',
    description:
      'Run the automated rule checks over the draft you are reviewing: sourcing, price arithmetic, tier consistency, and dropped seller disclosures.',
    parameters: listingIdArg,
    execute() {
      const { context } = deps;
      context.violations = checkDraft(context);
      const blocking = codesOf(context.violations, 'blocking');
      logger.log(
        `${tag(context, 'check_draft')}: ${blocking.length ? `blocking: ${blocking.join(', ')}` : 'no blocking violations'}; ${codesOf(context.violations, 'warning').length} warning(s)`,
      );
      return summarize(context.violations);
    },
  });

/** The verification pass's only exit. */
export const submitReviewTool = (deps: ToolDeps) =>
  tool({
    name: 'submit_review',
    description:
      'Submit your verification result: per-claim findings, any omissions, and the verdict.',
    parameters: reviewSchema,
    execute(args) {
      const step = tag(deps.context, 'submit_review');
      const parsed = reviewSchema.safeParse(args);
      if (!parsed.success) {
        logger.warn(
          `${step}: rejected, wrong shape (${parsed.error.issues.length} issue(s))`,
        );
        return `Review rejected — wrong shape:\n${issues(parsed.error)}`;
      }
      const { verdict, findings, omissions } = parsed.data;
      deps.context.review = parsed.data;
      deps.context.finished = true;
      logger.log(
        `${step}: ${verdict} — ${findings.length} finding(s), ${findings.filter((finding) => finding.status === 'contradicted').length} contradicted, ${omissions.length} omission(s)`,
      );
      return 'Review recorded.';
    },
  });

const issues = (error: z.ZodError) =>
  error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
