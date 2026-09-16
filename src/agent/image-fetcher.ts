import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

const FETCH_TIMEOUT_MS = 20_000;
/** Below this a response is a placeholder or tracking pixel, not a photo. */
const MIN_IMAGE_BYTES = 2048;

/**
 * Longest edge a photo is sent at.
 *
 * gpt-4.1-mini bills an image by its pixel area, so a phone photo sent whole
 * costs about 4,000–4,500 tokens; at 1536px it costs about 2,200–2,500. The
 * number is not arbitrary: gpt-4.1 scales every photo to 768px on its short
 * side before reading it, so the verification pass sees exactly what it saw
 * before, and the drafting pass still reads labels at a higher resolution
 * than the pass that checks them. Going lower would start taking detail away
 * from the verifier.
 */
const MAX_EDGE_PX = 1536;
/** High enough that re-encoding does not blur the small print on a spec label. */
const JPEG_QUALITY = 90;

export interface FetchedImage {
  /** Position in the listing's `images` array — how a claim cites it. */
  index: number;
  url: string;
  ok: boolean;
  /** base64 `data:` URL, so the same bytes serve both passes. */
  dataUrl?: string;
  error?: string;
}

/**
 * Fetches, validates and shrinks listing images, once per URL per process.
 *
 * Whether a URL yields a usable image is an HTTP question, not a judgement
 * call, so it is settled here rather than by spending a vision call to find out
 * a link is dead. The bytes are cached because both passes need the same
 * photographs, and the second one should not pay to download them again —
 * and they are shrunk here, once, so every model call that attaches them pays
 * for the smaller version.
 */
@Injectable()
export class ImageFetcher {
  private readonly logger = new Logger(ImageFetcher.name);
  private readonly cache = new Map<string, Promise<FetchedImage>>();

  fetchAll(urls: string[]): Promise<FetchedImage[]> {
    return Promise.all(
      urls.map(async (url, index) => {
        let pending = this.cache.get(url);
        if (!pending) {
          pending = this.download(url);
          this.cache.set(url, pending);
        }
        // Index is per-listing, so stamp it on rather than reuse the cached one.
        return { ...(await pending), index };
      }),
    );
  }

  private async download(url: string): Promise<FetchedImage> {
    const unusable = (error: string): FetchedImage => {
      this.logger.warn(`Unusable image (${error}): ${url}`);
      return { index: -1, url, ok: false, error };
    };

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return unusable(`HTTP ${response.status}`);
      }

      const type =
        response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!type.startsWith('image/')) {
        return unusable(`not an image (${type || 'no content-type'})`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength < MIN_IMAGE_BYTES) {
        return unusable(`too small (${bytes.byteLength}B)`);
      }

      const sent = await this.shrink(url, bytes, type);
      return {
        index: -1,
        url,
        ok: true,
        dataUrl: `data:${sent.type};base64,${sent.bytes.toString('base64')}`,
      };
    } catch (error) {
      return unusable((error as Error).message);
    }
  }

  /**
   * Scales a photo down so its longest edge is at most `MAX_EDGE_PX`.
   *
   * A photo already within bounds is sent untouched, bytes and format as they
   * came. A photo that cannot be decoded is sent untouched too: shrinking is a
   * saving, and failing to make one must not cost the listing a photo.
   */
  private async shrink(
    url: string,
    bytes: Buffer,
    type: string,
  ): Promise<{ bytes: Buffer; type: string }> {
    try {
      const { width, height } = await sharp(bytes).metadata();
      if (!width || !height || Math.max(width, height) <= MAX_EDGE_PX) {
        return { bytes, type };
      }

      const resized = await sharp(bytes)
        // Bake in the EXIF orientation first. Re-encoding drops the metadata,
        // and a phone photo without it comes out sideways.
        .rotate()
        .resize({
          width: MAX_EDGE_PX,
          height: MAX_EDGE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        // JPEG has no transparency; without this a transparent PNG goes black.
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();

      this.logger.log(
        `Resized ${width}x${height} to fit ${MAX_EDGE_PX}px (${Math.round(bytes.byteLength / 1024)}KB → ${Math.round(resized.byteLength / 1024)}KB): ${url}`,
      );
      return { bytes: resized, type: 'image/jpeg' };
    } catch (error) {
      this.logger.warn(
        `Could not resize, sending the original (${(error as Error).message}): ${url}`,
      );
      return { bytes, type };
    }
  }
}
