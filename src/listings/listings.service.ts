import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Image, ImageDocument } from '../images/schemas/image.schema';
import { CreateListingDto } from './dto/create-listing.dto';
import { Category } from './enums/category.enum';
import { Listing, ListingDocument } from './schemas/listing.schema';

@Injectable()
export class ListingsService {
  constructor(
    @InjectModel(Listing.name)
    private readonly listings: Model<ListingDocument>,
    @InjectModel(Image.name)
    private readonly images: Model<ImageDocument>,
  ) {}

  async findAll(page: number, limit: number, category?: Category) {
    const filter = category ? { category } : {};
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

    const listingIds = items.map((item) => item._id);
    const coverImages = await this.images
      .aggregate<{ _id: Types.ObjectId; s3Url: string }>([
        { $match: { listing: { $in: listingIds } } },
        { $sort: { listing: 1, sequenceNo: 1 } },
        { $group: { _id: '$listing', s3Url: { $first: '$s3Url' } } },
      ])
      .exec();
    const coverImageByListingId = new Map(
      coverImages.map((image) => [image._id.toString(), image.s3Url]),
    );

    return {
      items: items.map(({ _id, id: _mongooseId, ...item }) => ({
        id: _id.toString(),
        image: coverImageByListingId.get(_id.toString()) ?? null,
        ...item,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async create(sellerId: string, dto: CreateListingDto) {
    const { imageUrls, ...listingFields } = dto;

    const listing = await new this.listings({
      ...listingFields,
      sellerId: new Types.ObjectId(sellerId),
    }).save();

    if (imageUrls?.length) {
      await this.images.insertMany(
        imageUrls.map((s3Url, index) => ({
          listing: listing._id,
          s3Url,
          sequenceNo: index,
        })),
      );
    }

    return { id: listing._id.toString() };
  }
}
