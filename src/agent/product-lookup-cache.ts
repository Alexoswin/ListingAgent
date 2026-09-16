import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ProductLookup } from './schemas';

/**
 * A product lookup worth reusing: the answer, where it came from, and the URLs
 * that grounded it.
 */
export interface CachedProductLookup {
  lookup: ProductLookup;
  evidence: 'web' | 'model_knowledge';
  sources: string[];
}

/**
 * Persistent backing for the cache.
 *
 * Optional by design. The CLI boots `AgentModule` on its own with no database,
 * and a cache is an optimisation rather than a correctness requirement — a run
 * with no store simply pays for every lookup, exactly as it does today.
 */
export interface ProductLookupStore {
  get(key: string): Promise<CachedProductLookup | null>;
  set(key: string, value: CachedProductLookup): Promise<void>;
}

export const PRODUCT_LOOKUP_STORE = Symbol('PRODUCT_LOOKUP_STORE');

/**
 * How long a cached lookup stays usable.
 *
 * Generous because the field that matters is the launch price, which is a
 * historical fact and does not move. The expiry is there to let corrections
 * and better search results work their way in, not to track a changing price.
 */
export const LOOKUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Cap on the in-process map, so a long-lived server cannot grow it forever. */
const MAX_ENTRIES = 500;

/**
 * The cache key for one product.
 *
 * Normalised hard — case, punctuation and spacing all collapse — because the
 * same laptop arrives as "ASUS TUF-Gaming F15", "asus tuf gaming f15" and
 * "Asus  TUF  Gaming   F15" across three sellers, and those have to be one key
 * for the cache to be worth anything.
 */
export function lookupKey(
  brand: string,
  model: string,
  category: string,
): string {
  const clean = (part: string) =>
    part
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return [clean(brand), clean(model), clean(category)].join('|');
}

/**
 * Remembers product lookups so the same product is searched once, not once per
 * listing.
 *
 * Two layers: an in-process map that survives a single run, and an optional
 * persistent store that survives the process. Both are best-effort — every
 * failure path here falls through to "not cached", because a broken cache must
 * cost a search, never a listing.
 */
@Injectable()
export class ProductLookupCache {
  private readonly logger = new Logger(ProductLookupCache.name);
  private readonly memory = new Map<
    string,
    { value: CachedProductLookup; expiresAt: number }
  >();

  constructor(
    @Optional()
    @Inject(PRODUCT_LOOKUP_STORE)
    private readonly store: ProductLookupStore | null = null,
  ) {}

  /** Whether lookups outlive this process. Logged once, at startup, by the agent. */
  get persistent(): boolean {
    return this.store !== null;
  }

  async get(key: string): Promise<CachedProductLookup | null> {
    const hit = this.memory.get(key);
    if (hit) {
      if (hit.expiresAt > Date.now()) {
        return hit.value;
      }
      this.memory.delete(key);
    }

    if (!this.store) {
      return null;
    }
    try {
      const stored = await this.store.get(key);
      if (stored) {
        this.remember(key, stored);
      }
      return stored;
    } catch (error) {
      this.logger.warn(
        `Could not read "${key}" from the store: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async set(key: string, value: CachedProductLookup): Promise<void> {
    // Only web-grounded answers are kept. A model-knowledge result means the
    // search failed, and caching it would pin that one failure in place for
    // every later listing of the same product — turning a transient outage
    // into a month of unverified MRPs.
    if (value.evidence !== 'web') {
      return;
    }

    this.remember(key, value);
    try {
      await this.store?.set(key, value);
    } catch (error) {
      this.logger.warn(
        `Could not write "${key}" to the store: ${(error as Error).message}`,
      );
    }
  }

  private remember(key: string, value: CachedProductLookup) {
    // Map preserves insertion order, so the first key is the oldest write.
    if (this.memory.size >= MAX_ENTRIES) {
      for (const oldest of this.memory.keys()) {
        this.memory.delete(oldest);
        break;
      }
    }
    this.memory.set(key, { value, expiresAt: Date.now() + LOOKUP_TTL_MS });
  }
}
