import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { AgentService } from './agent.service';
import { ImageFetcher } from './image-fetcher';
import { ProductLookupCache } from './product-lookup-cache';

/**
 * The agent, with no database dependency: it reads a listing and returns a
 * result. The CLI boots this module on its own, so `run-agent` needs nothing
 * but API keys, while the HTTP app can import it alongside the Mongo modules.
 *
 * The lookup cache is the one piece that can use a database, and it reaches
 * for one only if `ProductLookupStoreModule` is loaded somewhere in the app.
 */
@Module({
  imports: [LlmModule],
  providers: [AgentService, ImageFetcher, ProductLookupCache],
  exports: [AgentService],
})
export class AgentModule {}
