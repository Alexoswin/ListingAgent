import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { LogRange } from './agent-logs.service';
import {
  ListingApiLog,
  ListingApiLogDocument,
} from './schemas/listing-api-log.schema';

export interface ApiLogEntry {
  endpoint: string;
  sellerId: string;
  runLogId?: Types.ObjectId;
  listingId?: Types.ObjectId;
  requestedAt: Date;
  statusCode: number;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: unknown;
}

@Injectable()
export class ListingApiLogsService {
  private readonly logger = new Logger(ListingApiLogsService.name);

  constructor(
    @InjectModel(ListingApiLog.name)
    private readonly logs: Model<ListingApiLogDocument>,
  ) {}

  /** Never throws: a logging failure must not fail the request it describes. */
  async record(entry: ApiLogEntry) {
    const output = entry.output as
      | {
          generated_pdp?: { category?: string; title?: string } | null;
          review?: { verdict?: string };
        }
      | undefined;
    try {
      await this.logs.create({
        endpoint: entry.endpoint,
        sellerId: new Types.ObjectId(entry.sellerId),
        runLogId: entry.runLogId,
        listingId: entry.listingId,
        requestedAt: entry.requestedAt,
        durationMs: Date.now() - entry.requestedAt.getTime(),
        statusCode: entry.statusCode,
        success: entry.statusCode < 400,
        inputCategory: entry.input.category as string | undefined,
        inputTitle: entry.input.title as string | undefined,
        outputCategory: output?.generated_pdp?.category,
        outputTitle: output?.generated_pdp?.title,
        verdict: output?.review?.verdict,
        input: entry.input,
        output: entry.output,
        ...(entry.error !== undefined && {
          errorMessage:
            entry.error instanceof Error
              ? entry.error.message.slice(0, 1000)
              : 'Unknown error',
        }),
      });
    } catch (error) {
      this.logger.error(
        `Could not record API log: ${(error as Error).message}`,
      );
    }
  }

  async list(range: LogRange, page: number, limit: number) {
    const filter = { requestedAt: { $gte: range.from, $lte: range.to } };
    const [items, total] = await Promise.all([
      this.logs
        .find(filter)
        .select({ input: 0, output: 0, sellerId: 0 })
        .sort({ requestedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.logs.countDocuments(filter),
    ]);
    return {
      items: items.map(({ _id, listingId, runLogId, ...item }) => ({
        ...item,
        id: _id.toString(),
        listingId: listingId?.toString() ?? null,
        runLogId: runLogId?.toString() ?? null,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Log not found');
    }
    const log = await this.logs.findById(id).select({ sellerId: 0 }).lean();
    if (!log) {
      throw new NotFoundException('Log not found');
    }
    const { _id, listingId, runLogId, ...fields } = log;
    return {
      ...fields,
      id: _id.toString(),
      listingId: listingId?.toString() ?? null,
      runLogId: runLogId?.toString() ?? null,
    };
  }

  async analytics(range: LogRange) {
    const match = { requestedAt: { $gte: range.from, $lte: range.to } };
    const corrected = {
      $and: [
        { $ne: [{ $ifNull: ['$outputCategory', null] }, null] },
        { $ne: ['$outputCategory', '$inputCategory'] },
      ],
    };
    const [result] = await this.logs.aggregate([
      { $match: match },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalRequests: { $sum: 1 },
                successfulRequests: { $sum: { $cond: ['$success', 1, 0] } },
                failedRequests: { $sum: { $cond: ['$success', 0, 1] } },
                categoryCorrections: { $sum: { $cond: [corrected, 1, 0] } },
                averageDurationMs: { $avg: '$durationMs' },
                maxDurationMs: { $max: '$durationMs' },
              },
            },
            { $project: { _id: 0 } },
          ],
          daily: [
            {
              $group: {
                _id: {
                  $dateToString: { format: '%Y-%m-%d', date: '$requestedAt' },
                },
                successful: { $sum: { $cond: ['$success', 1, 0] } },
                failed: { $sum: { $cond: ['$success', 0, 1] } },
                averageDurationMs: { $avg: '$durationMs' },
              },
            },
            {
              $project: {
                _id: 0,
                date: '$_id',
                successful: 1,
                failed: 1,
                averageDurationMs: 1,
              },
            },
            { $sort: { date: 1 } },
          ],
          statusCodes: [
            { $group: { _id: '$statusCode', requests: { $sum: 1 } } },
            { $project: { _id: 0, statusCode: '$_id', requests: 1 } },
            { $sort: { statusCode: 1 } },
          ],
          categories: [
            {
              $group: {
                _id: '$inputCategory',
                requests: { $sum: 1 },
                corrected: { $sum: { $cond: [corrected, 1, 0] } },
                averageDurationMs: { $avg: '$durationMs' },
              },
            },
            {
              $project: {
                _id: 0,
                category: '$_id',
                requests: 1,
                corrected: 1,
                averageDurationMs: 1,
              },
            },
            { $sort: { requests: -1 } },
          ],
        },
      },
    ]);
    return {
      range,
      summary: result?.summary[0] ?? {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        categoryCorrections: 0,
        averageDurationMs: 0,
        maxDurationMs: 0,
      },
      daily: result?.daily ?? [],
      statusCodes: result?.statusCodes ?? [],
      categories: result?.categories ?? [],
    };
  }
}
