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

/** Tool arguments arrive as `unknown`; take a string or nothing. */
const asText = (value: unknown) =>
  typeof value === 'string' ? value.trim() : '';

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
    async execute(_input, _runContext, details) {
      const { context, config, llm } = deps;
      recordToolCall(context, 'analyze_images');
      // Reported to the trace, which prints the call with these notes once the
      // SDK hands its output back to the model, and records a failure as one.
      return context.trace.tool(
        details?.toolCall?.callId,
        'analyze_images',
        async (note) => {
          if (context.analysis) {
            note('reused the cached analysis');
            return JSON.stringify(context.analysis);
          }
          const images = usableImages(context).length;
          if (images === 0) {
            note('no usable image, nothing to analyse', 'warn');
            return 'No image loaded for this listing. Nothing can be verified visually; say so in the draft and keep the specifications to what the seller claims.';
          }

          const { seller, category, subcategory } = context.listing;
          const { object, usage } = await llm.generateObject({
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
          });

          recordUsage(context, usage);
          context.analysis = object;
          note(
            `read ${images} image(s): brand ${object.observed_brand ?? 'not visible'}, ${object.observations.length} observation(s), ${object.visible_damage.length} damage note(s)`,
          );
          // What it read, so a wrong value in a draft can be traced to this call
          // or to the drafting pass.
          note(
            object.observations
              .map(
                (o) =>
                  `${o.attribute}=${o.value}${o.legible ? '' : ' (illegible)'}`,
              )
              .join('; ') || 'nothing legible',
          );
          return JSON.stringify(object);
        },
      );
    },
  });

/**
 * A tool the AI can call to find a product's original price (MRP) and its specs.
 *
 * Why we need it: photos can't show what a product cost when new, and sellers
 * usually leave that blank. So we look it up on the web.
 *
 * How it works:
 * 1. If we looked up this product before, reuse that answer (free, no AI call).
 * 2. If not, ask the AI to search the web.
 * 3. If the web search fails, ask the AI to answer from what it already knows,
 *    and mark the answer as "unverified".
 */
export const productLookupTool = (deps: ToolDeps) =>
  tool({
    // The name the AI uses to call this tool.
    name: 'product_lookup',
    // Tells the AI what this tool does and when to use it.
    description:
      "Find a product's original list price when new (MRP) and its manufacturer specifications. Use it for the MRP, and to corroborate specs you could not read off the photos.",
    // The details the AI must give us when it calls this tool.
    parameters: z.strictObject({
      brand: z.string().describe('Brand name, e.g. "ASUS".'),
      model: z.string().describe('Model as precisely as you know it.'),
      category: z
        .string()
        .describe('What kind of product, e.g. "gaming laptop".'),
    }),
    // This runs every time the AI calls the tool.
    async execute(args, _runContext, details) {
      const { context, config, llm, lookupCache } = deps;

      // Count this call in the run's stats.
      recordToolCall(context, 'product_lookup');

      // Read the details the AI gave us, as plain text.
      const brand = asText(args.brand);
      const model = asText(args.model);
      const category = asText(args.category);

      // Show this tool call in the terminal. Each note() adds a line under it.
      return context.trace.tool(
        details?.toolCall?.callId,
        'product_lookup',
        async (note) => {
          // Without a brand or a model there is nothing to search for.
          if (!brand && !model) {
            note('no brand or model given, nothing to look up', 'warn');
            return 'Nothing to look up: no brand or model given. If neither is known, leave original_mrp null.';
          }

          // The product's full name, e.g. "Nintendo Switch Lite MOD. HDH-001".
          const product = [brand, model].filter(Boolean).join(' ');

          // Check whether we already looked up this product.
          const key = lookupKey(brand, model, category);
          const cached = await lookupCache.get(key);
          if (cached) {
            // Found it: reuse the saved answer. No AI call and no web search.
            context.lookups.push({
              ...cached.lookup,
              evidence: cached.evidence,
            });
            note(
              `reused a cached lookup for "${product}": ${cached.lookup.matched_product ?? 'no match'}, MRP ${cached.lookup.original_mrp_inr ?? 'not found'} (no model call)`,
            );
            // The cache only keeps answers that came from the web, so this is always 'lookup_web'.
            return JSON.stringify({
              ...cached.lookup,
              sources: cached.sources,
              cite_as: 'lookup_web',
            });
          }

          // What the photos showed (brand, model text and so on), written as text.
          const evidence = visualEvidence(context);
          // Send the photos too only if nothing readable was found on them.
          const attachPhotos = needsPhotos(context);

          // Builds the message we send to the AI.
          // Only the last instruction changes between the web search and the backup.
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
                  // Add the photos if needed. They help the AI work out the exact
                  // version of the product when the model name is vague.
                  ...(attachPhotos ? imageParts(context) : []),
                ],
              },
            ],
          });

          note(
            `searched the web for "${product}" ${attachPhotos ? 'with the photos, nothing legible to go on' : 'from the image analysis, no photos'}`,
          );
          let lookup: LlmWebSearchResponse<ProductLookup>;
          try {
            // First try: ask the AI to search the web, preferring results from India.
            lookup = await llm.generateObjectWithWebSearch({
              ...request(
                'Search the web for its original launch price in India and its manufacturer specifications. Use only what the search results support; do not add specifications they do not mention.',
              ),
              searchCountry: 'IN',
            });
          } catch (error) {
            // Backup: the web search failed, so ask the AI to answer from what it knows.
            // There are no web links, so this answer counts as unverified.
            note(
              `web search failed, falling back to model knowledge: ${(error as Error).message}`,
              'warn',
            );
            lookup = {
              ...(await llm.generateObject(
                request(
                  'No search results are available, so answer from your own knowledge and be conservative: return null rather than a half-remembered price.',
                ),
              )),
              sources: [],
            };
          }

          const { object, usage, sources } = lookup;

          // Where did the answer come from? No web links means it came from
          // the AI's own memory, whatever the answer says.
          const grounding = sources.length
            ? ('web' as const)
            : ('model_knowledge' as const);

          // Count the tokens this used.
          recordUsage(context, usage);

          // Save the answer for this listing.
          context.lookups.push({ ...object, evidence: grounding });

          // Keep only the first 5 web links. The draft doesn't need them all.
          const cited = sources.slice(0, 5);

          // Save the answer so the next listing of the same product can reuse it.
          // (The cache ignores answers that didn't come from the web.)
          await lookupCache.set(key, {
            lookup: object,
            evidence: grounding,
            sources: cited,
          });

          // Print what we found in the terminal. Warn if it didn't come from the web.
          const found = `${object.matched_product ?? 'no match'}, MRP ${object.original_mrp_inr ?? 'not found'}`;
          if (grounding === 'web') {
            note(`${found}, from ${sources.length} web source(s)`);
          } else {
            note(`${found}, from model knowledge only (unverified)`, 'warn');
          }

          // Send the answer back to the AI. 'cite_as' tells it which source
          // label to use for the price in the listing.
          return JSON.stringify({
            ...object,
            sources: cited,
            cite_as:
              grounding === 'web' ? 'lookup_web' : 'lookup_model_knowledge',
          });
        },
      );
    },
  });
