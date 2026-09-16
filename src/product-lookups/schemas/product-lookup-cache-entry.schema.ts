import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import type { ProductLookup } from '../../agent/schemas';

export type ProductLookupCacheEntryDocument =
  HydratedDocument<ProductLookupCacheEntry>;

/** One cached product lookup, keyed by normalised brand, model and category. */
@Schema({ timestamps: true, collection: 'product_lookup_cache' })
export class ProductLookupCacheEntry {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  lookup: ProductLookup;

  @Prop({ type: String, enum: ['web', 'model_knowledge'], required: true })
  evidence: 'web' | 'model_knowledge';

  @Prop({ type: [String], default: [] })
  sources: string[];

  @Prop({ required: true })
  expiresAt: Date;
}

export const ProductLookupCacheEntrySchema = SchemaFactory.createForClass(
  ProductLookupCacheEntry,
);

// Mongo deletes the document once `expiresAt` passes. The cache also checks
// the date on read, because the TTL monitor only sweeps about once a minute.
ProductLookupCacheEntrySchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);
