import { IsIn, IsNotEmpty, IsString } from 'class-validator';

const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
];

export class CreateUploadUrlDto {
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType: string;
}
