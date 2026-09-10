import { Logger } from '@nestjs/common';
import type { AgentConfig } from './agent.config';

const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 5;

interface TavilyBody {
  results?: { title?: string; url?: string; content?: string }[];
}

interface SerperBody {
  organic?: { title?: string; link?: string; snippet?: string }[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const logger = new Logger('WebSearch');

/**
 * One web search, against whichever backend has a key. Two are supported only
 * so a reviewer holding either one gets a real lookup; with neither, the caller
 * falls back to model knowledge and labels the answer as such.
 */
export async function webSearch(
  { backend, apiKey }: AgentConfig['search'],
  query: string,
): Promise<SearchResult[]> {
  if (backend === 'none' || !apiKey) {
    return [];
  }

  const request: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  } =
    backend === 'tavily'
      ? {
          url: 'https://api.tavily.com/search',
          headers: { authorization: `Bearer ${apiKey}` },
          body: { query, max_results: MAX_RESULTS, search_depth: 'basic' },
        }
      : {
          url: 'https://google.serper.dev/search',
          headers: { 'X-API-KEY': apiKey },
          body: { q: query, num: MAX_RESULTS, gl: 'in' },
        };

  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Tavily returns `results[].content`; Serper returns `organic[].snippet`.
    const json: unknown = await response.json();
    if (backend === 'tavily') {
      const { results = [] } = json as TavilyBody;
      return results.slice(0, MAX_RESULTS).map((row) => ({
        title: row.title ?? '',
        url: row.url ?? '',
        snippet: row.content ?? '',
      }));
    }
    const { organic = [] } = json as SerperBody;
    return organic.slice(0, MAX_RESULTS).map((row) => ({
      title: row.title ?? '',
      url: row.link ?? '',
      snippet: row.snippet ?? '',
    }));
  } catch (error) {
    logger.warn(`Search failed for "${query}": ${(error as Error).message}`);
    return [];
  }
}
