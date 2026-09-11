import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AgentService } from '../agent/agent.service';
import type { SellerListing } from '../agent/types';

/**
 * CLI entrypoint:
 *   npm run agent -- --input data/listings.json --output output/results.json
 *
 * A standalone Nest context, not the HTTP app, so the run needs no database,
 * no port and no auth — only an API key.
 */
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), AgentModule] })
class AgentCliModule {}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag.startsWith('--')) {
      args[flag.slice(2)] = argv[i + 1]?.startsWith('--')
        ? ''
        : (argv[++i] ?? '');
    }
  }
  return args;
}

async function main() {
  const logger = new Logger('RunAgent');
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.input || 'data/listings.json');
  const outputPath = resolve(args.output || 'output/results.json');

  const all = JSON.parse(await readFile(inputPath, 'utf8')) as SellerListing[];
  // `--only 1,4` keeps a single listing cheap to iterate on.
  const wanted = args.only
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const listings = wanted?.length
    ? all.filter((listing) => wanted.includes(listing.listing_id))
    : all;

  const app = await NestFactory.createApplicationContext(AgentCliModule, {
    logger: ['log', 'warn', 'error'],
  });
  const agent = app.get(AgentService);

  logger.log(
    `${listings.length} listing(s) · ${agent.config.generate} → ${agent.config.verify} · search: ${agent.config.search.backend}`,
  );

  const results = await agent.run(listings);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);

  const published = results.filter((result) => result.publish).length;
  const usage = results.reduce(
    (total, result) => ({
      inputTokens: total.inputTokens + result.diagnostics.usage.inputTokens,
      outputTokens: total.outputTokens + result.diagnostics.usage.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );

  logger.log(
    `${published} auto_publish, ${results.length - published} human_review_needed → ${outputPath}`,
  );
  logger.log(`Tokens: ${usage.inputTokens} in, ${usage.outputTokens} out`);
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
