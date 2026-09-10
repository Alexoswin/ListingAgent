import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Listing } from '../../listings/schemas/listing.schema';

export type ImageDocument = HydratedDocument<Image>;

@Schema({ timestamps: true })
export class Image {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: Listing.name,
    required: true,
    index: true,
  })
  listing: Types.ObjectId;

  @Prop({ trim: true, required: true })
  s3Url: string;

  @Prop({ default: false, index: true })
  humanVerification: boolean;

  @Prop({ default: false, index: true })
  aiVerification: boolean;

  @Prop({ min: 0, required: true })
  sequenceNo: number;
}

export const ImageSchema = SchemaFactory.createForClass(Image);

ImageSchema.index({ listing: 1, sequenceNo: 1 }, { unique: true });
