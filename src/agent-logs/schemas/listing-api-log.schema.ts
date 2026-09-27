import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Listing } from '../../listings/schemas/listing.schema';
import { User } from '../../users/schemas/user.schema';
import { AgentRunLog } from './agent-run-log.schema';

export type ListingApiLogDocument = HydratedDocument<ListingApiLog>;

/**
 * One call to `POST /listings/generate`: the request body exactly as the
 * seller sent it and the response body exactly as the API returned it (or the
 * error). `AgentRunLog` holds the aggregate numbers for analytics; this holds
 * the payloads, so a single run can be replayed and inspected.
 */
@Schema({ timestamps: true, collection: 'listing_api_logs' })
export class ListingApiLog {
  @Prop({ required: true, trim: true })
  endpoint: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: AgentRunLog.name,
    index: true,
  })
  runLogId?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Listing.name, index: true })
  listingId?: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: User.name,
    required: true,
    index: true,
  })
  sellerId: Types.ObjectId;

  @Prop({ required: true, index: true })
  requestedAt: Date;

  @Prop({ required: true, min: 0 })
  durationMs: number;

  @Prop({ required: true, index: true })
  statusCode: number;

  @Prop({ required: true, index: true })
  success: boolean;

  /** Denormalised from `input` / `output` so the list and charts skip the payloads. */
  @Prop({ trim: true, index: true })
  inputCategory?: string;

  @Prop({ trim: true })
  outputCategory?: string;

  @Prop({ trim: true })
  inputTitle?: string;

  @Prop({ trim: true })
  outputTitle?: string;

  @Prop({ type: String, enum: ['auto_publish', 'human_review_needed'] })
  verdict?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  input: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  output?: Record<string, unknown>;

  @Prop({ trim: true })
  errorMessage?: string;
}

export const ListingApiLogSchema = SchemaFactory.createForClass(ListingApiLog);

ListingApiLogSchema.index({ requestedAt: -1 });
