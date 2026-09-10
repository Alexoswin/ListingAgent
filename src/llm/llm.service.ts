import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LlmObjectRequest,
  LlmObjectResponse,
  LlmProvider,
  LlmProviderName,
  LlmRequest,
  LlmResponse,
} from './llm.types';
import { GeminiProvider } from './providers/gemini.provider';
import { OpenAiProvider } from './providers/openai.provider';

// The .env variable holding each provider's API key.
const API_KEY_VARS: Record<LlmProviderName, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * The class the rest of the app uses to call an LLM. Each call names its
 * provider and model, and this routes it to the matching provider, e.g.
 * `llm.generate({ provider: 'openai', model: 'gpt-4.1-mini', messages })`.
 */
@Injectable()
export class LlmService {
  // Provider clients created so far, reused across calls.
  private readonly providers = new Map<LlmProviderName, LlmProvider>();

  constructor(private readonly config: ConfigService) {}

  /** Returns the model's text and/or the tool calls it wants to make. */
  async generate(request: LlmRequest): Promise<LlmResponse> {
    // `return await` keeps a missing API key a rejected promise rather than a synchronous throw.
    return await this.provider(request.provider).generate(request);
  }

  /** Returns an object validated against `request.schema`. */
  async generateObject<T>(
    request: LlmObjectRequest<T>,
  ): Promise<LlmObjectResponse<T>> {
    return await this.provider(request.provider).generateObject(request);
  }

  /**
   * Returns the client for `name`, creating it on first use. Only providers you
   * actually call need a key, so a missing Gemini key never affects OpenAI calls.
   */
  private provider(name: LlmProviderName): LlmProvider {
    let provider = this.providers.get(name);
    if (!provider) {
      const apiKey = this.config.get<string>(API_KEY_VARS[name]);
      // Fail with a clear message instead of an opaque auth error from the SDK.
      if (!apiKey) {
        throw new Error(`${API_KEY_VARS[name]} is not set`);
      }
      provider =
        name === 'openai'
          ? new OpenAiProvider(apiKey)
          : new GeminiProvider(apiKey);
      this.providers.set(name, provider);
    }
    return provider;
  }
}
