import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../llm/llm.service';
import { resolveAgentConfig, type AgentConfig } from './agent.config';
import { hasBlocking } from './draft-checker';
import { ImageFetcher } from './image-fetcher';
import {
  buildGenerateMessages,
  buildVerifyMessages,
  GENERATE_SYSTEM,
  VERIFY_SYSTEM,
} from './prompts/pass-prompts';
import type { AgentReview, GeneratedPdp, Verdict } from './schemas';
import { runPass } from './agent-runner';
import {
  analyzeImagesTool,
  checkDraftTool,
  productLookupTool,
  submitDraftTool,
  submitReviewTool,
  type ToolDeps,
} from './tools';
import {
  createRunContext,
  usableImages,
  type RunContext,
  type SellerListing,
  type Violation,
} from './types';

export interface ListingResult {
  listing_id: string;
  generated_pdp: GeneratedPdp | null;
  review: {
    verdict: Verdict;
    findings: AgentReview['findings'];
    omissions: string[];
    notes: string;
    rule_violations: Violation[];
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
  ) {}

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
   */
  async runListing(listing: SellerListing): Promise<ListingResult> {
    const id = listing.listing_id;
    const started = Date.now();
    this.logger.log(
      `Listing ${id}: started (${listing.category}${listing.subcategory ? ` / ${listing.subcategory}` : ''}, ${listing.images.length} image(s))`,
    );

    const context = createRunContext(
      listing,
      await this.images.fetchAll(listing.images),
    );
    this.logImages(context);
    const deps: ToolDeps = { llm: this.llm, config: this.config, context };

    // Which pass was running, so a failure log says where it broke.
    let stage = 'generate';
    try {
      await runPass({
        model: this.config.generate,
        system: GENERATE_SYSTEM,
        messages: buildGenerateMessages(context),
        tools: [
          analyzeImagesTool(deps), //Reads the listing's images
          productLookupTool(deps), // Looks up a product's canonical specs and its original MRP
          submitDraftTool(deps),
        ],
        maxSteps: 8,
        context,
        label: `generate:${listing.listing_id}`,
      });

      if (context.draft) {
        stage = 'verify';
        await runPass({
          model: this.config.verify,
          system: VERIFY_SYSTEM,
          messages: buildVerifyMessages(context),
          tools: [
            checkDraftTool(deps),
            productLookupTool(deps),
            submitReviewTool(deps),
          ],
          maxSteps: 6,
          context,
          label: `verify:${listing.listing_id}`,
        });
      } else {
        this.logger.error(
          `Listing ${id}: no draft produced, skipping verification`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Listing ${id}: ${stage} pass failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }

    const result = this.assemble(context);
    const summary = `Listing ${id}: ${result.review.verdict} in ${Date.now() - started}ms (${context.usage.inputTokens} in / ${context.usage.outputTokens} out tokens)`;
    if (result.publish) {
      this.logger.log(summary);
    } else {
      // Escalating is the expected outcome for a doubtful listing, not a crash,
      // so it is a warning; the reasons say whether anything actually broke.
      this.logger.warn(
        `${summary}: ${result.review.escalation_reasons.join(' ') || 'the reviewer asked for human review.'}`,
      );
    }
    return result;
  }

  /** One line for the image fetch, at a level that matches how it went. */
  private logImages(context: RunContext) {
    const id = context.listing.listing_id;
    const submitted = context.images.length;
    const loaded = usableImages(context).length;
    if (loaded === submitted) {
      this.logger.log(`Listing ${id}: ${loaded} image(s) loaded`);
    } else if (loaded === 0) {
      this.logger.error(
        `Listing ${id}: none of ${submitted} image(s) loaded, nothing can be verified visually`,
      );
    } else {
      this.logger.warn(
        `Listing ${id}: ${loaded} of ${submitted} image(s) loaded`,
      );
    }
  }

  /**
   * The verdict gate.
   *
   * The reviewing model's verdict is honoured when it says escalate, and only
   * nominates when it says publish. Two of the checks below read the model's
   * own findings back to it: a review that lists a contradicted claim and then
   * votes to publish is a real and common failure. The rest do not depend on
   * anything a model saw, which is what covers a photograph that misleads both
   * passes the same way — no amount of looking again would catch that.
   */
  private assemble(context: RunContext): ListingResult {
    const { listing, draft, review, violations } = context;
    const contradicted = (review?.findings ?? []).filter(
      (finding) => finding.status === 'contradicted',
    );

    const escalations = [
      !draft && 'No draft was produced.',
      !review && 'No review was produced.',
      hasBlocking(violations) &&
        `Blocking rule violations: ${violations
          .filter((violation) => violation.severity === 'blocking')
          .map((violation) => violation.code)
          .join(', ')}.`,
      contradicted.length > 0 &&
        `Review contradicted: ${contradicted.map((finding) => finding.claim).join('; ')}.`,
      (review?.omissions.length ?? 0) > 0 &&
        `Review found omissions: ${review?.omissions.join('; ')}.`,
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
        rule_violations: violations,
        escalation_reasons: escalations,
      },
      publish: verdict === 'auto_publish',
      diagnostics: {
        images_submitted: context.images.length,
        images_loaded: usableImages(context).length,
        models: `${this.config.generate} → ${this.config.verify}`,
        decorrelated: this.config.decorrelated,
        usage: context.usage,
      },
    };
  }
}
