import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';

/**
 * Makes `LlmService` injectable. Add `imports: [LlmModule]` to any module
 * that needs to call an LLM, then inject `LlmService` in its constructor.
 */
@Module({
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
