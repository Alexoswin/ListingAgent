import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  LOOKUP_TTL_MS,
  type CachedProductLookup,
  type ProductLookupStore,
} from '../agent/product-lookup-cache';
import { ProductLookupCacheEntry } from './schemas/product-lookup-cache-entry.schema';

/** Keeps product lookups in Mongo, so they outlive the process that made them. */
@Injectable()
export class MongoProductLookupStore implements ProductLookupStore {
  constructor(
    @InjectModel(ProductLookupCacheEntry.name)
    private readonly entries: Model<ProductLookupCacheEntry>,
  ) {}

  async get(key: string): Promise<CachedProductLookup | null> {
    const entry = await this.entries
      .findOne({ key, expiresAt: { $gt: new Date() } })
      .lean()
      .exec();
    return entry
      ? {
          lookup: entry.lookup,
          evidence: entry.evidence,
          sources: entry.sources,
        }
      : null;
  }

  async set(key: string, value: CachedProductLookup): Promise<void> {
    await this.entries
      .updateOne(
        { key },
        {
          $set: {
            ...value,
            expiresAt: new Date(Date.now() + LOOKUP_TTL_MS),
          },
        },
        { upsert: true },
      )
      .exec();
  }
}
