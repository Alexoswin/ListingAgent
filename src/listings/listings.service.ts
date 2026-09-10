import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Listing, ListingDocument } from './schemas/listing.schema';

@Injectable()
export class ListingsService {
  constructor(
    @InjectModel(Listing.name)
    private readonly listings: Model<ListingDocument>,
  ) {}

  async findAll(page: number, limit: number, category?: string) {
    const filter = category ? { category: category.trim() } : {};
    const skip = (page - 1) * limit;
    const projection = {
      _id: 1,
      title: 1,
      desc: 1,
      price: 1,
      originalPrice: 1,
      brand: 1,
      model: 1,
      yearPurchased: 1,
      specs: 1,
      conditionDetails: 1,
      category: 1,
      subcategory: 1,
    };
    const [items, total] = await Promise.all([
      this.listings
        .find(filter)
        .select(projection)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.listings.countDocuments(filter),
    ]);

    return {
      items: items.map(({ _id, id: _mongooseId, ...item }) => ({
        id: _id.toString(),
        ...item,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }
}
