import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { AgentRunStats } from '../../agent/types';
import { Listing } from '../../listings/schemas/listing.schema';
import { User } from '../../users/schemas/user.schema';

export type AgentRunLogDocument = HydratedDocument<AgentRunLog>;

export enum AgentRunStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

@Schema({ timestamps: true })
export class AgentRunLog {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Listing.name, index: true })
  listingId?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: User.name, required: true, index: true })
  sellerId: Types.ObjectId;

  @Prop({ required: true, index: true })
  startedAt: Date;

  @Prop({ index: true })
  completedAt?: Date;

  @Prop({ min: 0 })
  durationMs?: number;

  @Prop({ type: String, enum: AgentRunStatus, required: true, index: true })
  status: AgentRunStatus;

  @Prop({ type: String, enum: ['auto_publish', 'human_review_needed'], index: true })
  verdict?: string;

  @Prop({ default: false, index: true })
  listingSaved: boolean;

  @Prop({ min: 0, required: true })
  imagesSubmitted: number;

  @Prop({ min: 0 })
  imagesLoaded?: number;

  @Prop({ type: MongooseSchema.Types.Mixed })
  stats?: AgentRunStats;

  @Prop({ min: 0 })
  totalInputTokens?: number;

  @Prop({ min: 0 })
  totalOutputTokens?: number;

  @Prop({ min: 0 })
  totalToolCalls?: number;

  @Prop({ min: 0 })
  findingCount?: number;

  @Prop({ min: 0 })
  omissionCount?: number;

  @Prop({ min: 0 })
  violationCount?: number;

  @Prop({ trim: true })
  errorStage?: 'generation' | 'validation' | 'persistence';

  @Prop({ trim: true })
  errorMessage?: string;
}

export const AgentRunLogSchema = SchemaFactory.createForClass(AgentRunLog);

AgentRunLogSchema.index({ startedAt: -1 });
AgentRunLogSchema.index({ status: 1, startedAt: -1 });
