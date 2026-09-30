import { tool } from '@openai/agents';
import { z } from 'zod';
import type { LlmService } from '../llm/llm.service';
import type { LlmObjectRequest, LlmWebSearchResponse } from '../llm/llm.types';
import type { AgentConfig } from './agent.config';
import {
  lookupKey,
  type CachedProductLookup,
  type ProductLookupCache,
} from './product-lookup-cache';
import {
  imageAnalysisSchema,
  productLookupSchema,
  type ProductLookup,
} from './schemas';
import type { ToolNote } from './trace';
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

/** The last line of the lookup request, when the AI can search the web. */
const WEB_SEARCH_INSTRUCTION =
  'Search the web for its original launch price in India and its manufacturer specifications. Use only what the search results support; do not add specifications they do not mention.';

/** The last line of the lookup request, when the web search failed. */
const FROM_MEMORY_INSTRUCTION =
  'No search results are available, so answer from your own knowledge and be conservative: return null rather than a half-remembered price.';

/**
 * A tool the AI can call to read the listing's photos: brand and model
 * markings, readable specs, damage, accessories, and stock photos.
 */
export const analyzeImagesTool = (deps: ToolDeps) =>
  tool({
    name: 'analyze_images',
    description:
      "Look at the listing's photographs and report what is visible: brand and model markings, readable specs, damage, accessories, and whether any image is a stock photo. Call this before drafting.",
    parameters: listingIdArg,
    async execute(_input, _runContext, details) {
      // Count this call in the run's stats.
      recordToolCall(deps.context, 'analyze_images');

      // Show this tool call in the terminal. Each note() adds a line under it.
      return deps.context.trace.tool(
        details?.toolCall?.callId,
        'analyze_images',
        (note) => analyzeImages(deps, note),
      );
    },
  });

/** Asks the AI what the photos show and returns that as the tool's reply. */
async function analyzeImages(
  { context, config, llm }: ToolDeps,
  note: ToolNote,
): Promise<string> {
  // The AI often asks twice, and the photos don't change: reuse the first answer.
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
  const text = [
    todayLine(),
    `Category: ${category}${subcategory ? ` / ${subcategory}` : ''}`,
    `The seller says this is: ${[seller.brand, seller.model].filter(Boolean).join(' ') || 'unspecified'}`,
    '',
    'Treat that as a claim to check, not a description to confirm. Report what you see.',
  ].join('\n');

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
        content: [{ type: 'text', text }, ...imageParts(context)],
      },
    ],
  });
  recordUsage(context, usage);
  context.analysis = object;

  // Print what it read, so a wrong value in a draft can be traced back here.
  note(
    `read ${images} image(s): brand ${object.observed_brand ?? 'not visible'}, ${object.observations.length} observation(s), ${object.visible_damage.length} damage note(s)`,
  );
  note(
    object.observations
      .map((o) => `${o.attribute}=${o.value}${o.legible ? '' : ' (illegible)'}`)
      .join('; ') || 'nothing legible',
  );

  return JSON.stringify(object);
}

/**
 * A tool the AI can call to find a product's original price (MRP) and its specs.
 *
 * Why we need it: photos can't show what a product cost when new, and sellers
 * usually leave that blank. So we look it up on the web.
 *
 * How it works (the steps are in `lookUpProduct` below):
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
      // Count this call in the run's stats.
      recordToolCall(deps.context, 'product_lookup');

      // The SDK has already checked these are strings; just trim the spaces.
      const product: ProductQuery = {
        brand: args.brand.trim(),
        model: args.model.trim(),
        category: args.category.trim(),
      };

      // Show this tool call in the terminal. Each note() adds a line under it.
      return deps.context.trace.tool(
        details?.toolCall?.callId,
        'product_lookup',
        (note) => lookUpProduct(deps, product, note),
      );
    },
  });

/** The product the AI asked us to look up. */
interface ProductQuery {
  brand: string;
  model: string;
  category: string;
}

/** Runs the lookup steps and returns the tool's reply to the AI. */
async function lookUpProduct(
  deps: ToolDeps,
  product: ProductQuery,
  note: ToolNote,
): Promise<string> {
  const { context, lookupCache } = deps;
  const { brand, model, category } = product;

  // Without a brand or a model there is nothing to search for.
  if (!brand && !model) {
    note('no brand or model given, nothing to look up', 'warn');
    return 'Nothing to look up: no brand or model given. If neither is known, leave original_mrp null.';
  }

  // The product's full name, e.g. "Nintendo Switch Lite MOD. HDH-001".
  const name = [brand, model].filter(Boolean).join(' ');

  // Step 1: if we looked up this product before, reuse that answer.
  // No AI call and no web search.
  ///---
  const key = lookupKey(brand, model, category);
  const cached = await lookupCache.get(key);
  if (cached) {
    note(
      `reused a cached lookup for "${name}": ${summarize(cached.lookup)} (no model call)`,
    );
    return reply(context, cached);
  }

  //-- 

  // Steps 2 and 3: ask the AI, with a web search if it works.
  note(
    `searched the web for "${name}" ${needsPhotos(context) ? 'with the photos, nothing legible to go on' : 'from the image analysis, no photos'}`,
  );
  // web search 
  const { object, usage, sources } = await askAboutProduct(deps, product, note);
  recordUsage(context, usage);

  // The answer, in the same shape the cache stores.
  const answer: CachedProductLookup = {
    lookup: object,
    // No web links means the answer came from the AI's own memory,
    // whatever the answer says.
    evidence: sources.length > 0 ? 'web' : 'model_knowledge',
    // Keep only the first 5 web links. The draft doesn't need them all.
    sources: sources.slice(0, 5),
  };

  // Save the answer so the next listing of the same product can reuse it.
  // (The cache ignores answers that didn't come from the web.)
  await lookupCache.set(key, answer);

  // Print what we found in the terminal. Warn if it didn't come from the web.
  if (answer.evidence === 'web') {
    note(`${summarize(object)}, from ${sources.length} web source(s)`);
  } else {
    note(
      `${summarize(object)}, from model knowledge only (unverified)`,
      'warn',
    );
  }

  return reply(context, answer);
}

/**
 * Asks the AI about the product: with a web search first, and from its own
 * knowledge if the search fails. The backup answer has no web links, which is
 * how `lookUpProduct` knows it is unverified.
 */
async function askAboutProduct(
  deps: ToolDeps,
  product: ProductQuery,
  note: ToolNote,
): Promise<LlmWebSearchResponse<ProductLookup>> {
  try {
    // Search the web, preferring results from India.
    return await deps.llm.generateObjectWithWebSearch({
      ...lookupRequest(deps, product, WEB_SEARCH_INSTRUCTION),
      searchCountry: 'IN',
      // A launch price rarely needs more than two searches, and reading less
      // of each result saves tokens and time on every uncached lookup.
      searchContextSize: 'low',
      maxSearches: 2,
    });
  } catch (error) {
    // The fallback to model knowledge is off for now: pass the failure on.
    // trace.tool prints it, and the SDK tells the AI the lookup failed.
    // note(
    //   `web search failed, falling back to model knowledge: ${(error as Error).message}`,
    //   'warn',
    // );
    // const answer = await deps.llm.generateObject(
    //   lookupRequest(deps, product, FROM_MEMORY_INSTRUCTION),
    // );
    // return { ...answer, sources: [] };
    throw error;
  }
}

/**
 * Builds the request we send to the AI. The web search and the backup send
 * the same request; only the last instruction changes.
 */
function lookupRequest(
  { config, context }: ToolDeps,
  { brand, model, category }: ProductQuery,
  instruction: string,
): LlmObjectRequest<ProductLookup> {
  // What the photos showed (brand, model text and so on), written as text.
  const evidence = visualEvidence(context);
  const text = [
    `Identify: ${brand} ${model} (${category})`,
    evidence && `\nWhat the photographs were read to show:\n${evidence}`,
    `\n${instruction}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    model: config.generate,
    system: LOOKUP_SYSTEM,
    schema: productLookupSchema,
    schemaName: 'product_lookup',
    reasoningEffort: 'low',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text },
          // Send the photos too only if nothing readable was found on them.
          // They help the AI work out the exact version of the product when
          // the model name is vague.
          ...(needsPhotos(context) ? imageParts(context) : []),
        ],
      },
    ],
  };
}

/**
 * What `analyze_images` read off the photos, written as text for the lookup.
 *
 * Only the readable details: the analysis wasn't sure about the unreadable
 * ones, and passing them to the search as facts would turn a guess into a
 * "found" answer.
 */
function visualEvidence(context: RunContext): string {
  const analysis = context.analysis;
  if (!analysis) {
    return '';
  }
  const legible = analysis.observations.filter((o) => o.legible);
  return [
    analysis.observed_brand &&
      `Brand visible on the item: ${analysis.observed_brand}`,
    analysis.observed_model_text &&
      `Model text visible on the item: ${analysis.observed_model_text}`,
    legible.length > 0 &&
      `Readable details: ${legible.map((o) => `${o.attribute}: ${o.value}`).join('; ')}`,
    analysis.visible_accessories.length > 0 &&
      `Accessories in frame: ${analysis.visible_accessories.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Whether the lookup should get the photos too.
 *
 * Usually not: the brand and model read off the photos are enough to search
 * with. The photos are only worth sending when neither could be read.
 */
function needsPhotos(context: RunContext): boolean {
  return (
    !context.analysis ||
    (!context.analysis.observed_brand && !context.analysis.observed_model_text)
  );
}

/**
 * Saves the answer for this listing and writes the tool's reply to the AI.
 * 'cite_as' tells the AI which source label to use for the price in the listing.
 */
function reply(
  context: RunContext,
  { lookup, evidence, sources }: CachedProductLookup,
): string {
  context.lookups.push({ ...lookup, evidence });
  return JSON.stringify({
    ...lookup,
    sources,
    cite_as: evidence === 'web' ? 'lookup_web' : 'lookup_model_knowledge',
  });
}

/** One line for the terminal: the product it matched and its MRP. */
function summarize(lookup: ProductLookup): string {
  return `${lookup.matched_product ?? 'no match'}, MRP ${lookup.original_mrp_inr ?? 'not found'}`;
}
