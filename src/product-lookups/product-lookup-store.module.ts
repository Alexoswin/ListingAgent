import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PRODUCT_LOOKUP_STORE } from '../agent/product-lookup-cache';
import { MongoProductLookupStore } from './mongo-product-lookup.store';
import {
  ProductLookupCacheEntry,
  ProductLookupCacheEntrySchema,
} from './schemas/product-lookup-cache-entry.schema';

/**
 * Gives the agent's lookup cache a Mongo backing.
 *
 * Global so `AgentModule` can pick the store up without importing this module:
 * `AgentModule` has to stay free of any database dependency, because the CLI
 * boots it alone. The HTTP app imports this; the CLI does not, and there the
 * cache quietly runs in memory only.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: ProductLookupCacheEntry.name,
        schema: ProductLookupCacheEntrySchema,
      },
    ]),
  ],
  providers: [
    MongoProductLookupStore,
    { provide: PRODUCT_LOOKUP_STORE, useExisting: MongoProductLookupStore },
  ],
  exports: [PRODUCT_LOOKUP_STORE],
})
export class ProductLookupStoreModule {}
