import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ListingResult } from '../agent/agent.service';
import { AgentRunLog, AgentRunLogDocument, AgentRunStatus } from './schemas/agent-run-log.schema';

const DEFAULT_RANGE_DAYS = 30;

export interface LogRange {
  from: Date;
  to: Date;
}

@Injectable()
export class AgentLogsService {
  constructor(
    @InjectModel(AgentRunLog.name)
    private readonly logs: Model<AgentRunLogDocument>,
  ) {}

  async start(sellerId: string, listingId: Types.ObjectId, imagesSubmitted: number) {
    return new this.logs({
      sellerId: new Types.ObjectId(sellerId),
      listingId,
      startedAt: new Date(),
      status: AgentRunStatus.Running,
      imagesSubmitted,
      listingSaved: false,
    }).save();
  }

  async complete(logId: Types.ObjectId, result: ListingResult, listingSaved: boolean) {
    const stats = result.diagnostics.stages;
    const totalToolCalls = Object.values(stats.generation.toolCalls).reduce(
      (total, count) => total + count,
      0,
    ) + Object.values(stats.validation.toolCalls).reduce(
      (total, count) => total + count,
      0,
    );
    await this.logs.updateOne(
      { _id: logId },
      {
        $set: {
          completedAt: new Date(),
          durationMs: stats.generation.durationMs + stats.validation.durationMs,
          status: listingSaved ? AgentRunStatus.Completed : AgentRunStatus.Failed,
          verdict: result.review.verdict,
          listingSaved,
          imagesLoaded: result.diagnostics.images_loaded,
          stats,
          totalInputTokens: result.diagnostics.usage.inputTokens,
          totalOutputTokens: result.diagnostics.usage.outputTokens,
          totalToolCalls,
          findingCount: result.review.findings.length,
          omissionCount: result.review.omissions.length,
          violationCount: result.review.rule_violations.length,
        },
      },
    );
  }

  async fail(logId: Types.ObjectId, stage: 'generation' | 'validation' | 'persistence', error: unknown) {
    await this.logs.updateOne(
      { _id: logId },
      {
        $set: {
          completedAt: new Date(),
          status: AgentRunStatus.Failed,
          errorStage: stage,
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
        },
      },
    );
  }

  async list(range: LogRange, page: number, limit: number) {
    const filter = { startedAt: { $gte: range.from, $lte: range.to } };
    const [items, total] = await Promise.all([
      this.logs
        .find(filter)
        .select({ sellerId: 0, errorMessage: 0 })
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.logs.countDocuments(filter),
    ]);
    return {
      items: items.map(({ _id, listingId, ...item }) => ({
        ...item,
        id: _id.toString(),
        listingId: listingId?.toString() ?? null,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async analytics(range: LogRange) {
    const match = { startedAt: { $gte: range.from, $lte: range.to } };
    const [result] = await this.logs.aggregate([
      { $match: match },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalRuns: { $sum: 1 },
                completedRuns: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                failedRuns: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
                autoPublishedRuns: { $sum: { $cond: [{ $eq: ['$verdict', 'auto_publish'] }, 1, 0] } },
                humanReviewRuns: { $sum: { $cond: [{ $eq: ['$verdict', 'human_review_needed'] }, 1, 0] } },
                inputTokens: { $sum: { $ifNull: ['$totalInputTokens', 0] } },
                outputTokens: { $sum: { $ifNull: ['$totalOutputTokens', 0] } },
                averageDurationMs: { $avg: '$durationMs' },
              },
            },
          ],
          daily: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt' } },
                runs: { $sum: 1 },
                inputTokens: { $sum: { $ifNull: ['$totalInputTokens', 0] } },
                outputTokens: { $sum: { $ifNull: ['$totalOutputTokens', 0] } },
              },
            },
            { $project: { _id: 0, date: '$_id', runs: 1, inputTokens: 1, outputTokens: 1 } },
            { $sort: { date: 1 } },
          ],
          models: [
            {
              $project: {
                stages: [
                  { stage: 'generation', model: '$stats.generation.model', inputTokens: '$stats.generation.inputTokens', outputTokens: '$stats.generation.outputTokens' },
                  { stage: 'validation', model: '$stats.validation.model', inputTokens: '$stats.validation.inputTokens', outputTokens: '$stats.validation.outputTokens' },
                ],
              },
            },
            { $unwind: '$stages' },
            { $match: { 'stages.model': { $ne: null } } },
            {
              $group: {
                _id: { stage: '$stages.stage', model: '$stages.model' },
                runs: { $sum: 1 },
                inputTokens: { $sum: { $ifNull: ['$stages.inputTokens', 0] } },
                outputTokens: { $sum: { $ifNull: ['$stages.outputTokens', 0] } },
              },
            },
            { $project: { _id: 0, stage: '$_id.stage', model: '$_id.model', runs: 1, inputTokens: 1, outputTokens: 1 } },
            { $sort: { stage: 1, model: 1 } },
          ],
          tools: [
            {
              $project: {
                stages: [
                  { stage: 'generation', toolCalls: '$stats.generation.toolCalls' },
                  { stage: 'validation', toolCalls: '$stats.validation.toolCalls' },
                ],
              },
            },
            { $unwind: '$stages' },
            { $project: { stage: '$stages.stage', calls: { $objectToArray: '$stages.toolCalls' } } },
            { $unwind: '$calls' },
            { $group: { _id: { stage: '$stage', tool: '$calls.k' }, calls: { $sum: '$calls.v' } } },
            { $project: { _id: 0, stage: '$_id.stage', tool: '$_id.tool', calls: 1 } },
            { $sort: { stage: 1, tool: 1 } },
          ],
        },
      },
    ]);
    return {
      range,
      summary: result?.summary[0] ?? emptySummary(),
      daily: result?.daily ?? [],
      models: result?.models ?? [],
      tools: result?.tools ?? [],
    };
  }

  range(from?: string, to?: string): LogRange {
    const end = to ? new Date(`${to}T23:59:59.999Z`) : new Date();
    const start = from ? new Date(`${from}T00:00:00.000Z`) : new Date(end.getTime() - DEFAULT_RANGE_DAYS * 86400000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      throw new Error('Invalid date range');
    }
    return { from: start, to: end };
  }
}

const emptySummary = () => ({
  totalRuns: 0, completedRuns: 0, failedRuns: 0, autoPublishedRuns: 0,
  humanReviewRuns: 0, inputTokens: 0, outputTokens: 0, averageDurationMs: 0,
});
