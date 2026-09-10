import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { AgentService } from './agent.service';
import { ImageFetcher } from './image-fetcher';

/**
 * The agent, with no database dependency: it reads a listing and returns a
 * result. The CLI boots this module on its own, so `run-agent` needs nothing
 * but API keys, while the HTTP app can import it alongside the Mongo modules.
 */
@Module({
  imports: [LlmModule],
  providers: [AgentService, ImageFetcher],
  exports: [AgentService],
})
export class AgentModule {}
