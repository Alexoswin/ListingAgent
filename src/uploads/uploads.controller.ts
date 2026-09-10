import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { UploadsService } from './uploads.service';

@Controller('uploads')
@UseGuards(AuthGuard)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('s3-url')
  createUploadUrl(@Body() body: CreateUploadUrlDto) {
    return this.uploads.createUploadUrl(body.fileName, body.contentType);
  }
}
