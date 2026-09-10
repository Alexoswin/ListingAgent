import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.service';
import { CreateListingDto } from './dto/create-listing.dto';
import { Category } from './enums/category.enum';
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
    const validCategory = Object.values(Category).includes(
      category as Category,
    )
      ? (category as Category)
      : undefined;

    return this.listingsService.findAll(page, limit, validCategory);
  }

  @Post()
  @UseGuards(AuthGuard)
  create(
    @Req() request: Request & { user: AuthUser },
    @Body() body: CreateListingDto,
  ) {
    return this.listingsService.create(request.user.id, body);
  }
}
