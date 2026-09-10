import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

const UPLOAD_URL_EXPIRY_SECONDS = 60 * 5;

@Injectable()
export class UploadsService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(private readonly config: ConfigService) {
    this.region = this.config.get<string>('AWS_REGION') ?? 'us-east-1';
    this.s3 = new S3Client({ region: this.region });
    this.bucket = this.config.get<string>('AWS_S3_BUCKET') ?? '';
  }

  async createUploadUrl(
    fileName: string,
    contentType: string,
  ): Promise<{ uploadUrl: string; s3Url: string; key: string }> {
    if (!this.bucket) {
      throw new BadRequestException('AWS_S3_BUCKET is not configured');
    }

    const extension = fileName.includes('.')
      ? fileName.slice(fileName.lastIndexOf('.'))
      : '';
    const key = `listings/${randomUUID()}${extension}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3, command, {
      expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
    });

    const s3Url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;

    return { uploadUrl, s3Url, key };
  }
}
