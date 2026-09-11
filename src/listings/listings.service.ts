import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AgentService } from '../agent/agent.service';
import type { JsonRecord } from '../common/types/json-value';
import { Image, ImageDocument } from '../images/schemas/image.schema';
import { CreateListingDto } from './dto/create-listing.dto';
import { GenerateListingDto } from './dto/generate-listing.dto';
import { Category } from './enums/category.enum';
import { Listing, ListingDocument } from './schemas/listing.schema';

/** The listing fields the public API returns, for both the grid and one page. */
const LISTING_PROJECTION = {
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
  publish: 1,
} as const;

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    @InjectModel(Listing.name)
    private readonly listings: Model<ListingDocument>,
    @InjectModel(Image.name)
    private readonly images: Model<ImageDocument>,
    private readonly agent: AgentService,
  ) {}

  async findAll(page: number, limit: number, category?: Category) {
    const filter = category ? { category } : {};
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.listings
        .find(filter)
        .select(LISTING_PROJECTION)
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
      items: items.map(({ _id, ...item }) => ({
        ...item,
        id: _id.toString(),
        image: coverImageByListingId.get(_id.toString()) ?? null,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** One listing with all of its photos, in upload order. */
  async findOne(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Listing not found');
    }

    const listing = await this.listings
      .findById(id)
      .select(LISTING_PROJECTION)
      .lean();
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    const images = await this.images
      .find({ listing: listing._id })
      .sort({ sequenceNo: 1 })
      .select({ s3Url: 1, _id: 0 })
      .lean();

    const { _id, ...fields } = listing;
    return {
      ...fields,
      id: _id.toString(),
      images: images.map((image) => image.s3Url),
    };
  }

  async create(sellerId: string, dto: CreateListingDto) {
    const { imageUrls, ...listingFields } = dto;

    const listing = await new this.listings({
      ...listingFields,
      sellerId: new Types.ObjectId(sellerId),
    }).save();

    await this.saveImages(listing._id, imageUrls);
    return { id: listing._id.toString() };
  }

  /**
   * The agent-generated flow: the seller's submission and photos go to the
   * agent, which drafts the listing and then verifies its own draft. What it
   * produces is saved as the listing, and `publish` follows the verdict — so a
   * listing the agent could not vouch for exists but stays off the marketplace
   * until a person clears it.
   */
  async generate(sellerId: string, dto: GenerateListingDto) {
    const listingId = new Types.ObjectId();
    const id = listingId.toString();
    this.logger.log(
      `Generate ${id}: seller ${sellerId}, ${dto.category}, ${dto.imageUrls.length} image(s)`,
    );
    const result = await this.agent.runListing({
      listing_id: id,
      category: dto.category,
      subcategory: dto.subcategory,
      images: dto.imageUrls,
      seller: {
        title: dto.title,
        description: dto.desc ?? '',
        price: dto.price,
        original_price: dto.originalPrice ?? null,
        brand: dto.brand ?? null,
        model: dto.model ?? null,
        year_purchased: dto.yearPurchased ?? null,
        specs: (dto.specs ?? {}) as JsonRecord,
        condition_details: (dto.conditionDetails ?? {}) as JsonRecord,
      },
    });

    const pdp = result.generated_pdp;
    if (!pdp) {
      this.logger.error(
        `Generate ${id}: the agent produced no draft, nothing saved`,
      );
      throw new ServiceUnavailableException(
        'The agent could not produce a listing from these photos. Try again, or create the listing manually.',
      );
    }

    try {
      await new this.listings({
        _id: listingId,
        sellerId: new Types.ObjectId(sellerId),
        title: pdp.title,
        desc: pdp.description,
        price: dto.price,
        ...(pdp.original_mrp !== null && { originalPrice: pdp.original_mrp }),
        ...(dto.brand && { brand: dto.brand }),
        ...(dto.model && { model: dto.model }),
        ...(dto.yearPurchased && { yearPurchased: dto.yearPurchased }),
        specs: Object.fromEntries(
          pdp.specifications.map((spec) => [spec.key, spec.value]),
        ),
        conditionDetails: {
          ...pdp.condition,
          unverifiable_claims: pdp.unverifiable_claims,
        },
        category: dto.category,
        ...(dto.subcategory && { subcategory: dto.subcategory }),
        publish: result.publish,
      }).save();
      await this.saveImages(listingId, dto.imageUrls);
    } catch (error) {
      this.logger.error(
        `Generate ${id}: saving the listing failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }

    this.logger.log(
      `Generate ${id}: saved, ${result.publish ? 'published' : 'held for human review'}`,
    );
    return { id, ...result };
  }

  private saveImages(listing: Types.ObjectId, imageUrls?: string[]) {
    if (!imageUrls?.length) {
      return;
    }
    return this.images.insertMany(
      imageUrls.map((s3Url, sequenceNo) => ({ listing, s3Url, sequenceNo })),
    );
  }
}
