import { Controller, Get, Query } from '@nestjs/common';
import { ListingsService } from './listings.service';

@Controller('listings')
export class ListingsController {
  constructor(private readonly listingsService: ListingsService) {}

  @Get()
  findAll(
    @Query('page') pageParam = '1',
    @Query('limit') limitParam = '6',
    @Query('category') category?: string,
  ) {
    const page = Math.max(Number.parseInt(pageParam, 10) || 1, 1);
    const limit = Math.min(
      Math.max(Number.parseInt(limitParam, 10) || 6, 1),
      50,
    );

    return this.listingsService.findAll(page, limit, category);
  }
}
