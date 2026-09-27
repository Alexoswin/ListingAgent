import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentLogsController } from './agent-logs.controller';
import { AgentLogsService } from './agent-logs.service';
import { ListingApiLogsService } from './listing-api-logs.service';
import { AgentRunLog, AgentRunLogSchema } from './schemas/agent-run-log.schema';
import { ListingApiLog, ListingApiLogSchema } from './schemas/listing-api-log.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AgentRunLog.name, schema: AgentRunLogSchema },
      { name: ListingApiLog.name, schema: ListingApiLogSchema },
    ]),
  ],
  controllers: [AgentLogsController],
  providers: [AgentLogsService, ListingApiLogsService],
  exports: [AgentLogsService, ListingApiLogsService],
})
export class AgentLogsModule {}
