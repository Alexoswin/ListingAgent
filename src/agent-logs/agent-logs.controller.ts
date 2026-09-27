import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { AgentLogsService } from './agent-logs.service';
import { ListingApiLogsService } from './listing-api-logs.service';

@Controller('agent-logs')
export class AgentLogsController {
  constructor(
    private readonly logs: AgentLogsService,
    private readonly apiLogs: ListingApiLogsService,
  ) {}

  @Get()
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') pageParam = '1',
    @Query('limit') limitParam = '25',
  ) {
    return this.logs.list(this.range(from, to), Math.max(Number.parseInt(pageParam, 10) || 1, 1), Math.min(Math.max(Number.parseInt(limitParam, 10) || 25, 1), 100));
  }

  @Get('analytics')
  analytics(@Query('from') from?: string, @Query('to') to?: string) {
    return this.logs.analytics(this.range(from, to));
  }

  /** Request/response payloads of `POST /listings/generate`, newest first. */
  @Get('requests')
  requests(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') pageParam = '1',
    @Query('limit') limitParam = '25',
  ) {
    return this.apiLogs.list(this.range(from, to), Math.max(Number.parseInt(pageParam, 10) || 1, 1), Math.min(Math.max(Number.parseInt(limitParam, 10) || 25, 1), 100));
  }

  @Get('requests/analytics')
  requestAnalytics(@Query('from') from?: string, @Query('to') to?: string) {
    return this.apiLogs.analytics(this.range(from, to));
  }

  @Get('requests/:id')
  request(@Param('id') id: string) {
    return this.apiLogs.findOne(id);
  }

  private range(from?: string, to?: string) {
    try {
      return this.logs.range(from, to);
    } catch {
      throw new BadRequestException('Use valid YYYY-MM-DD dates with from on or before to');
    }
  }
}
