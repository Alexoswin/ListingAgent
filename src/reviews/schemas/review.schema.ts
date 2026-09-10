import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Listing } from '../../listings/schemas/listing.schema';
import { User } from '../../users/schemas/user.schema';

export type ReviewDocument = HydratedDocument<Review>;

export enum ReviewVerdict {
  AutoPublish = 'auto_publish',
  HumanReviewNeeded = 'human_review_needed',
}

@Schema({ timestamps: true })
export class Review {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: Listing.name,
    required: true,
    index: true,
  })
  listingId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: User.name,
    required: true,
    index: true,
  })
  reviewer: Types.ObjectId;

  @Prop({
    type: String,
    enum: ReviewVerdict,
    required: true,
    index: true,
  })
  verdict: ReviewVerdict;

  @Prop({
    type: String,
    trim: true,
  })
  notes?: string;
}

export const ReviewSchema = SchemaFactory.createForClass(Review);

// Useful for fetching reviews for a listing in newest-first order
ReviewSchema.index({ listingId: 1, createdAt: -1 });

// Useful for checking/fetching a user's reviews
ReviewSchema.index({ reviewer: 1, createdAt: -1 });
