import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

export enum UserRole {
  Admin = 'admin',
  Buyer = 'buyer',
  Reviewer = 'reviewer',
  Seller = 'seller',
}

@Schema({ timestamps: true })
export class User {
  @Prop({ trim: true, required: true })
  fullName: string;

  @Prop({ lowercase: true, trim: true, unique: true, sparse: true })
  email?: string;

  @Prop({ trim: true, unique: true, sparse: true })
  phone?: string;

  @Prop({ enum: UserRole, default: UserRole.Seller, index: true })
  role: UserRole;
  
  @Prop({ default: true, index: true })
  isActive: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
