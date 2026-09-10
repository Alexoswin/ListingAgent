import { Injectable, Logger } from '@nestjs/common';

const FETCH_TIMEOUT_MS = 20_000;
/** Below this a response is a placeholder or tracking pixel, not a photo. */
const MIN_IMAGE_BYTES = 2048;

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
 * Fetches and validates listing images, once per URL per process.
 *
 * Whether a URL yields a usable image is an HTTP question, not a judgement
 * call, so it is settled here rather than by spending a vision call to find out
 * a link is dead. The bytes are cached because both passes need the same
 * photographs, and the second one should not pay to download them again.
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

      return {
        index: -1,
        url,
        ok: true,
        dataUrl: `data:${type};base64,${bytes.toString('base64')}`,
      };
    } catch (error) {
      return unusable((error as Error).message);
    }
  }
}
