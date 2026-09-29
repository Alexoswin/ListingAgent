import { Logger } from '@nestjs/common';
import { tool } from '@openai/agents';
import { z } from 'zod';
import type { LlmService } from '../llm/llm.service';
import type { LlmWebSearchResponse } from '../llm/llm.types';
import type { AgentConfig } from './agent.config';
import { lookupKey, type ProductLookupCache } from './product-lookup-cache';
import {
  imageAnalysisSchema,
  productLookupSchema,
  type ProductLookup,
} from './schemas';
import {
  imageParts,
  recordToolCall,
  recordUsage,
  todayLine,
  usableImages,
  type RunContext,
} from './types';

export interface ToolDeps {
  llm: LlmService;
  config: AgentConfig;
  context: RunContext;
  lookupCache: ProductLookupCache;
}

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
- Note every scuff, scratch, dent, crack, stain, or missing part you can see.
- Transcribe text exactly as shown, every digit, letter and symbol. Products, models and software versions newer than your training data exist, and the brief gives today's date: never change a value you read to one you recognise.
- In visible_accessories, describe packaging, stickers and warranty cards along with whose branding they carry: the manufacturer's, or a retailer's or refurbisher's.
- If more than one unit of the item appears, say how many in the summary.`;

const LOOKUP_SYSTEM = `You identify consumer products and their original list price.

Return the price the product sold for NEW at launch, in INR, for the Indian market where you can tell. Never a resale, refurbished, or discounted price.

If the model string covers several variants at different prices and you cannot tell which this is, return null for the price and explain the ambiguity. Null is the correct answer whenever the evidence does not single out one variant.`;

/**
 * What `analyze_images` read off the photographs, as text for the lookup.
 *
 * Only legible observations: an illegible one is exactly the detail the
 * analysis refused to vouch for, and handing it to a search as if it were a
 * fact would launder a guess into a lookup result.
 */
function visualEvidence(context: RunContext): string {
  const analysis = context.analysis;
  if (!analysis) {
    return '';
  }
  const legible = analysis.observations.filter(
    (observation) => observation.legible,
  );
  return [
    analysis.observed_brand &&
      `Brand visible on the item: ${analysis.observed_brand}`,
    analysis.observed_model_text &&
      `Model text visible on the item: ${analysis.observed_model_text}`,
    legible.length > 0 &&
      `Readable details: ${legible.map((observation) => `${observation.attribute}: ${observation.value}`).join('; ')}`,
    analysis.visible_accessories.length > 0 &&
      `Accessories in frame: ${analysis.visible_accessories.join(', ')}`,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
}

/**
 * Whether the lookup needs the photographs themselves.
 *
 * Normally it does not: the analysis already turned the pixels into a brand and
 * model, which is what a search can use. The photos earn their tokens only when
 * the analysis could read neither off the item, and a second look is the only
 * way left to tell variants apart.
 */
const needsPhotos = (context: RunContext) =>
  !context.analysis ||
  (!context.analysis.observed_brand && !context.analysis.observed_model_text);

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
      recordToolCall(context, 'analyze_images');
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
          model: config.generate,
          system: ANALYZE_SYSTEM,
          schema: imageAnalysisSchema,
          schemaName: 'image_analysis',
          // None: this call reads what is in the photos, it does not reason about them.
          reasoningEffort: 'none',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: [
                    todayLine(),
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

      recordUsage(context, usage);
      context.analysis = object;
      logger.log(
        `${step}: done — brand ${object.observed_brand ?? 'not visible'}, ${object.observations.length} observation(s), ${object.visible_damage.length} damage note(s)`,
      );
      // What it read, so a wrong value in a draft can be traced to this call or
      // to the drafting pass.
      logger.log(
        `${step}: read ${object.observations.map((o) => `${o.attribute}=${o.value}${o.legible ? '' : ' (illegible)'}`).join('; ') || 'nothing legible'}`,
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
 *
 * Web search is the most expensive call in a run, and marketplace inventory
 * repeats — so a product already looked up is served from the cache with no
 * model call at all. The search itself gets the image analysis as text rather
 * than the photographs; see `needsPhotos` for when it gets the pixels too.
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
      const { context, config, llm, lookupCache } = deps;
      recordToolCall(context, 'product_lookup');
      const brand = asText(args.brand);
      const model = asText(args.model);
      const category = asText(args.category);

      const step = tag(context, 'product_lookup');
      if (!brand && !model) {
        logger.warn(`${step}: no brand or model given, nothing to look up`);
        return 'Nothing to look up: no brand or model given. If neither is known, leave original_mrp null.';
      }

      const product = [brand, model].filter(Boolean).join(' ');
      const key = lookupKey(brand, model, category);
      const cached = await lookupCache.get(key);
      if (cached) {
        context.lookups.push({ ...cached.lookup, evidence: cached.evidence });
        logger.log(
          `${step}: reused a cached lookup for "${product}" — ${cached.lookup.matched_product ?? 'no match'}, MRP ${cached.lookup.original_mrp_inr ?? 'not found'} (no model call)`,
        );
        return JSON.stringify({
          ...cached.lookup,
          sources: cached.sources,
          cite_as: 'lookup_web',
        });
      }

      const evidence = visualEvidence(context);
      const attachPhotos = needsPhotos(context);

      const request = (instruction: string) => ({
        model: config.generate,
        system: LOOKUP_SYSTEM,
        schema: productLookupSchema,
        schemaName: 'product_lookup',
        reasoningEffort: 'low' as const,
        messages: [
          {
            role: 'user' as const,
            content: [
              {
                type: 'text' as const,
                text: [
                  `Identify: ${brand} ${model} (${category})`,
                  evidence &&
                    `\nWhat the photographs were read to show:\n${evidence}`,
                  `\n${instruction}`,
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
              // The photos help pin the variant when the model string is vague,
              // which is most of this dataset ("7420 7 series i7 11 generation")
              // — but only when the analysis could not read one off the item.
              ...(attachPhotos ? imageParts(context) : []),
            ],
          },
        ],
      });

      logger.log(
        `${step}: searching the web for "${product}" (${attachPhotos ? 'with photos, nothing legible to go on' : 'from the image analysis, no photos'})`,
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
      const grounding = sources.length
        ? ('web' as const)
        : ('model_knowledge' as const);

      recordUsage(context, usage);
      context.lookups.push({ ...object, evidence: grounding });
      // A search can return dozens of URLs; the draft only needs a few.
      const cited = sources.slice(0, 5);
      await lookupCache.set(key, {
        lookup: object,
        evidence: grounding,
        sources: cited,
      });

      const found = `${object.matched_product ?? 'no match'}, MRP ${object.original_mrp_inr ?? 'not found'}`;
      if (grounding === 'web') {
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
        sources: cited,
        cite_as: grounding === 'web' ? 'lookup_web' : 'lookup_model_knowledge',
      });
    },
  });
