import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';
import type { JsonRecord } from '../../common/types/json-value';
import { Category, Subcategory } from '../enums/category.enum';

export type ListingDocument = HydratedDocument<Listing>;

@Schema({ timestamps: true })
export class Listing {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    auto: true,
    alias: 'listingId',
  })
  _id: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: User.name,
    index: true,
  })
  sellerId?: Types.ObjectId;

  @Prop({ trim: true, required: true })
  title: string;

  @Prop({ trim: true })
  desc?: string;

  @Prop({ required: true })
  price: number;

  @Prop()
  originalPrice?: number;

  @Prop({ trim: true })
  brand?: string;

  @Prop({ trim: true })
  model?: string;

  @Prop({ trim: true })
  yearPurchased?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  specs: JsonRecord;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  conditionDetails: JsonRecord;

  @Prop({ type: String, enum: Category, required: true, index: true })
  category: Category;

  @Prop({ type: String, enum: Subcategory, index: true })
  subcategory?: Subcategory;
}

export const ListingSchema = SchemaFactory.createForClass(Listing);

ListingSchema.index({ category: 1, subcategory: 1 });
