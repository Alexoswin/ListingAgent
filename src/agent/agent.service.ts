import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../llm/llm.service';
import { resolveAgentConfig, type AgentConfig } from './agent.config';
import { ImageFetcher } from './image-fetcher';
import { ProductLookupCache } from './product-lookup-cache';
import {
  buildGenerateMessages,
  buildVerifyMessages,
  GENERATE_SYSTEM,
  VERIFY_SYSTEM,
} from './prompts/pass-prompts';
import {
  pdpSchema,
  reviewSchema,
  type AgentReview,
  type GeneratedPdp,
  type Verdict,
} from './schemas';
import { runPass } from './agent-runner';
import { AgentTrace } from './trace';
import { analyzeImagesTool, productLookupTool, type ToolDeps } from './tools';
import {
  createRunContext,
  usableImages,
  type RunContext,
  type SellerListing,
} from './types';

export interface ListingResult {
  listing_id: string;
  generated_pdp: GeneratedPdp | null;
  review: {
    verdict: Verdict;
    findings: AgentReview['findings'];
    omissions: string[];
    notes: string;
    /** Why the run escalated, when the reviewing model did not ask it to. */
    escalation_reasons: string[];
  };
  /** Mirrors `Listing.publish`: true only on an `auto_publish` verdict. */
  publish: boolean;
  diagnostics: {
    images_submitted: number;
    images_loaded: number;
    models: string;
    decorrelated: boolean;
    usage: { inputTokens: number; outputTokens: number };
    stages: RunContext['stats'];
  };
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private resolved: AgentConfig | null = null;

  constructor(
    private readonly llm: LlmService,
    private readonly images: ImageFetcher,
    private readonly configService: ConfigService,
    private readonly lookupCache: ProductLookupCache,
    private readonly trace: AgentTrace,
  ) {
    this.logger.log(
      `Product lookup cache: ${lookupCache.persistent ? 'persistent (Mongo)' : 'in memory only'}`,
    );
  }

  /**
   * Resolved on first use, not in the constructor: the HTTP app imports this
   * module, and a missing API key should fail the request that needs a model,
   * not stop the server from booting.
   */
  get config(): AgentConfig {
    return (this.resolved ??= resolveAgentConfig(this.configService));
  }

  /** Processes every listing, a few at a time. */
  async run(listings: SellerListing[]): Promise<ListingResult[]> {
    const results: ListingResult[] = new Array<ListingResult>(listings.length);
    let next = 0;

    const worker = async () => {
      while (next < listings.length) {
        const index = next++;
        results[index] = await this.runListing(listings[index]);
      }
    };

    await Promise.all(
      Array.from({ length: Math.max(1, this.config.concurrency) }, worker),
    );
    return results;
  }

  /**
   * One listing: fetch the images once, draft, then verify the draft in a pass
   * that shares none of the drafting context.
   *
   * The verify pass gets no tools: it answers in a single turn. Its opening
   * turn carries the photographs, and the agent loop re-sends that whole turn
   * on every tool call, so each call would re-buy every image on the most
   * expensive model. What it needs from Pass A — the lookup results — is in its
   * brief instead.
   */
  async runListing(listing: SellerListing): Promise<ListingResult> {
    const trace = this.trace.listing(listing);
    try {
      const context = createRunContext(
        listing,
        await this.images.fetchAll(listing.images),
        trace,
      );
      trace.loaded(context);
      const deps: ToolDeps = {
        llm: this.llm,
        config: this.config,
        context,
        lookupCache: this.lookupCache,
      };

      // Which pass was running, so a failure says where it broke.
      let stage = 'generate';
      try {
        context.draft = await runPass({
          model: this.config.generate,
          system: GENERATE_SYSTEM,
          messages: buildGenerateMessages(context),
          outputType: pdpSchema,
          tools: [
            analyzeImagesTool(deps), //Reads the listing's images
            productLookupTool(deps), // Looks up a product's canonical specs and its original MRP
          ],
          maxSteps: 4,
          // Medium: drafting has to weigh photos, lookups and seller claims
          // against each other, and at low effort it kept values that contradicted
          // its own evidence. The verify pass stays above it, at high.
          reasoningEffort: 'low',
          context,
          label: `generate:${listing.listing_id}`,
          stage: 'generation',
          describe: (draft) =>
            `${draft.specifications.length} spec(s), tier ${draft.condition.tier}`,
        });

        if (context.draft) {
          stage = 'verify';
          context.review = await runPass({
            model: this.config.verify,
            system: VERIFY_SYSTEM,
            messages: buildVerifyMessages(context),
            outputType: reviewSchema,
            // No tools, so the review arrives on the first turn or not at all.
            maxSteps: 1,
            // High, above the drafting pass: it runs on the same model, so it has
            // to work harder than the drafter to be a real check on it.
            reasoningEffort: 'medium',
            context,
            label: `verify:${listing.listing_id}`,
            stage: 'validation',
            describe: ({ verdict, findings, omissions }) =>
              `${verdict} — ${findings.length} finding(s), ${findings.filter((finding) => finding.status === 'contradicted').length} contradicted, ${omissions.length} omission(s)`,
          });
        }
      } catch (error) {
        trace.failed(stage, error);
      }

      const result = this.assemble(context);
      trace.finished(result.review.verdict, result.review.escalation_reasons);
      return result;
    } finally {
      // Off the live lines even when fetching the images threw.
      trace.close();
    }
  }

  /**
   * The verdict gate.
   *
   * The reviewing model's verdict is honoured when it says escalate, and only
   * nominates when it says publish. Two of the checks below read the model's
   * own findings back to it: a review that lists a contradicted claim and then
   * votes to publish is a real and common failure.
   */
  private assemble(context: RunContext): ListingResult {
    const { listing, draft, review } = context;
    const contradicted = (review?.findings ?? []).filter(
      (finding) => finding.status === 'contradicted',
    );

    const escalations = [
      !draft && 'No draft was produced.',
      !review && 'No review was produced.',
      contradicted.length > 0 &&
        `Review contradicted: ${contradicted.map((finding) => finding.claim.replace(/[.\s]+$/, '')).join('; ')}.`,
      (review?.omissions.length ?? 0) > 0 &&
        `Review found omissions: ${review?.omissions.map((omission) => omission.replace(/[.\s]+$/, '')).join('; ')}.`,
    ].filter((reason): reason is string => typeof reason === 'string');

    const verdict: Verdict =
      escalations.length > 0 || review?.verdict !== 'auto_publish'
        ? 'human_review_needed'
        : 'auto_publish';

    return {
      listing_id: listing.listing_id,
      generated_pdp: draft,
      review: {
        verdict,
        findings: review?.findings ?? [],
        omissions: review?.omissions ?? [],
        notes: review?.notes ?? 'Verification did not complete.',
        escalation_reasons: escalations,
      },
      publish: verdict === 'auto_publish',
      diagnostics: {
        images_submitted: context.images.length,
        images_loaded: usableImages(context).length,
        models: `${this.config.generate} → ${this.config.verify}`,
        decorrelated: this.config.decorrelated,
        usage: context.usage,
        stages: context.stats,
      },
    };
  }
}
