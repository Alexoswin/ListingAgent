import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentLogsController } from './agent-logs.controller';
import { AgentLogsService } from './agent-logs.service';
import { AgentRunLog, AgentRunLogSchema } from './schemas/agent-run-log.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: AgentRunLog.name, schema: AgentRunLogSchema }])],
  controllers: [AgentLogsController],
  providers: [AgentLogsService],
  exports: [AgentLogsService],
})
export class AgentLogsModule {}
