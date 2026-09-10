import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { ImagesModule } from '../images/images.module';
import { Listing, ListingSchema } from './schemas/listing.schema';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Listing.name, schema: ListingSchema }]),
    ImagesModule,
    AuthModule,
  ],
  controllers: [ListingsController],
  providers: [ListingsService],
  exports: [MongooseModule, ListingsService],
})
export class ListingsModule {}
