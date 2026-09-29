import { Injectable } from '@nestjs/common';
import type { LlmReasoningEffort } from '../llm/llm.types';
import type { Verdict } from './schemas';
import { fit, Terminal, type Colour, type Frame, type Style } from './terminal';
import {
  usableImages,
  type AgentStage,
  type AgentStageStats,
  type RunContext,
  type SellerListing,
} from './types';

export type TraceLevel = 'ok' | 'warn' | 'error';

/** Reports one line about a tool call, printed under the call once it returns. */
export type ToolNote = (text: string, level?: TraceLevel) => void;

interface TokenCount {
  inputTokens: number;
  outputTokens: number;
}

interface Note {
  text: string;
  level: TraceLevel;
}

interface ToolCall {
  name: string;
  /** The arguments as the model sent them: a JSON string. */
  args: string;
  notes: Note[];
  startedAt: number | null;
  durationMs: number | null;
}

const LEVEL_STYLE: Record<TraceLevel, Style[]> = {
  ok: [],
  warn: ['yellow'],
  error: ['red'],
};
const MARK_COLOUR: Record<TraceLevel, Colour> = {
  ok: 'green',
  warn: 'yellow',
  error: 'red',
};
const STAGE_LABEL: Record<AgentStage, string> = {
  generation: 'Generate',
  validation: 'Verify',
};
/** Each pass in its own colour, so the two halves of a listing read apart. */
const STAGE_COLOUR: Record<AgentStage, Colour> = {
  generation: 'claude',
  validation: 'blue',
};
const STAGE_ACTIVITY: Record<AgentStage, string> = {
  generation: 'Drafting',
  validation: 'Verifying',
};
/** What the status line says while a tool runs. */
const TOOL_ACTIVITY: Record<string, string> = {
  analyze_images: 'Reading photos',
  product_lookup: 'Searching the web',
};
/** One per listing in turn, so listings running side by side can be told apart. */
const GUTTER_COLOURS: Colour[] = ['cyan', 'purple', 'pink', 'blue'];
/** A reasoning summary part usually opens with a bold headline. */
const HEADLINE = /^\s*\*\*(.+?)\*\*/s;

const zero = (): TokenCount => ({ inputTokens: 0, outputTokens: 0 });

const add = (a: TokenCount, b: TokenCount): TokenCount => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

/** A step of the way from what the counter shows to the real count. */
const roll = (shown: number, actual: number) =>
  shown >= actual ? actual : shown + Math.ceil((actual - shown) / 4);

const worst = (notes: Note[]): TraceLevel =>
  notes.some((note) => note.level === 'error')
    ? 'error'
    : notes.some((note) => note.level === 'warn')
      ? 'warn'
      : 'ok';

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const formatTokens = (count: number) =>
  count < 1000 ? `${count}` : `${(count / 1000).toFixed(1)}k`;

const formatUsage = (usage: TokenCount) =>
  `↑ ${formatTokens(usage.inputTokens)} ↓ ${formatTokens(usage.outputTokens)}`;

function formatDuration(ms: number): string {
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The agent's live trace: each listing's passes, the model's reasoning, and
 * every tool call with what it found, laid out the way Claude Code shows a
 * session. On a terminal, live lines under it show the tool calls in flight
 * and a status line with what is running now.
 *
 * Every line starts with the listing id, so listings running side by side stay
 * apart, and `grep` on an id still follows one listing through both passes.
 */
@Injectable()
export class AgentTrace {
  private readonly terminal = new Terminal();
  private readonly active = new Set<ListingTrace>();
  private verbose = false;
  private idWidth = 1;
  private traced = 0;
  /** When the live lines went up. */
  private since = 0;
  /** Tokens of the listings that finished while the live lines were up. */
  private settled = zero();
  /** The token count the status line shows, rolling up to the real one. */
  private shown = zero();

  /**
   * `verbose` prints the model's reasoning summaries in full rather than only
   * their headlines, and tool arguments uncut. `ids` are the listings a run
   * will trace, so their gutters line up from the first line.
   */
  configure(options: { verbose?: boolean; ids?: string[] }) {
    this.verbose = options.verbose ?? this.verbose;
    for (const id of options.ids ?? []) {
      this.idWidth = Math.max(this.idWidth, id.length);
    }
  }

  /** Opens a batch run with a Claude Code-style welcome box. */
  runStarted(run: { listings: number; concurrency: number; models: string }) {
    const { paint } = this.terminal;
    this.terminal.print([
      ...this.terminal.box(
        [
          `${paint('✻', 'claude')} ${paint('Listing agent', 'bold')}`,
          '',
          `  ${paint('listings', 'gray')}  ${run.listings} · ${run.concurrency} at a time`,
          `  ${paint('models', 'gray')}    ${run.models}`,
        ],
        'claude',
      ),
      '',
    ]);
  }

  /** Closes a batch run with its totals. */
  runFinished(run: {
    published: number;
    escalated: number;
    usage: TokenCount;
    durationMs: number;
    output: string;
  }) {
    const { paint } = this.terminal;
    this.terminal.print([
      '',
      `${paint('✻', 'claude')} ${paint('Done', 'bold')} ${paint(`in ${formatDuration(run.durationMs)} · ${formatUsage(run.usage)} tokens`, 'gray')}`,
      `  ${paint('⎿  ', 'gray')}${paint(`✔ ${run.published} auto_publish`, 'green')}${paint(' · ', 'gray')}${paint(`▲ ${run.escalated} human_review_needed`, 'yellow')}`,
      `     ${paint(run.output, 'gray')}`,
    ]);
  }

  /** Starts tracing one listing. Close the trace when the listing is done. */
  listing(listing: SellerListing): ListingTrace {
    const id = listing.listing_id;
    this.idWidth = Math.max(this.idWidth, id.length);
    const colour = GUTTER_COLOURS[this.traced++ % GUTTER_COLOURS.length];
    const gutter = `${this.terminal.paint(id.padStart(this.idWidth), colour)} ${this.terminal.paint('│', 'gray')} `;

    const trace = new ListingTrace(
      this.terminal,
      id,
      colour,
      gutter,
      this.verbose,
      (done) => this.closed(done),
    );
    if (this.active.size === 0) {
      this.since = Date.now();
      this.settled = zero();
      this.shown = zero();
    }
    this.active.add(trace);
    this.terminal.pin((frame) => this.live(frame));
    trace.started(listing);
    return trace;
  }

  private closed(trace: ListingTrace) {
    this.active.delete(trace);
    this.settled = add(this.settled, trace.usage);
    if (this.active.size === 0) {
      this.terminal.unpin();
    }
  }

  /**
   * The tool calls in flight, a blank line, then the status line:
   * `✻ 1 Drafting… · 4 Searching the web…  (12s · ↑ 41.2k ↓ 3.2k tokens)`
   */
  private live(frame: Frame): string[] {
    const { paint } = this.terminal;
    const listings = [...this.active];
    const doing = listings
      .map((trace) => `${trace.tag} ${frame.shimmer(`${trace.activity}…`)}`)
      .join(paint(' · ', 'gray'));
    const tokens = listings.reduce(
      (total, trace) => add(total, trace.usage),
      this.settled,
    );
    this.shown = {
      inputTokens: roll(this.shown.inputTokens, tokens.inputTokens),
      outputTokens: roll(this.shown.outputTokens, tokens.outputTokens),
    };
    const clock = `(${formatDuration(Date.now() - this.since)} · ${formatUsage(this.shown)} tokens)`;
    return [
      ...listings.flatMap((trace) => trace.inFlight(frame)),
      '',
      `${frame.spinner} ${doing}  ${paint(clock, 'gray')}`,
    ];
  }
}

/** One listing's part of the trace. The agent code reports to it as it goes. */
export class ListingTrace {
  private readonly startedAt = Date.now();
  private readonly calls = new Map<string, ToolCall>();
  private context: RunContext | null = null;
  /** The running pass, with the SDK's live count of its own turns' tokens. */
  private pass: { stage: AgentStage; usage: TokenCount } | null = null;
  private done = false;

  constructor(
    private readonly terminal: Terminal,
    private readonly id: string,
    private readonly colour: Colour,
    private readonly gutter: string,
    private readonly verbose: boolean,
    private readonly onClose: (trace: ListingTrace) => void,
  ) {}

  /** The listing id, styled, for the status line. */
  get tag(): string {
    return this.terminal.paint(this.id, this.colour, 'bold');
  }

  /** Tokens spent so far, the running pass's own turns included. */
  get usage(): TokenCount {
    const spent = this.context?.usage ?? zero();
    return this.pass ? add(spent, this.pass.usage) : spent;
  }

  /** What the listing is doing now, for the status line. */
  get activity(): string {
    if (!this.context) {
      return 'Fetching images';
    }
    const running = [...this.calls.values()]
      .filter((call) => call.startedAt !== null && call.durationMs === null)
      .map((call) => TOOL_ACTIVITY[call.name] ?? `Running ${call.name}`);
    if (running.length > 0) {
      return [...new Set(running)].join(', ');
    }
    return this.pass ? STAGE_ACTIVITY[this.pass.stage] : 'Working';
  }

  /**
   * The tool calls the model has made that have not returned yet, for the live
   * lines: a blinking mark and a ticking clock while each runs, then its
   * outcome's mark while it waits on the turn's other calls.
   */
  inFlight(frame: Frame): string[] {
    return [...this.calls.values()].map((call) => {
      const running = call.durationMs === null;
      const mark = running
        ? frame.lit
          ? this.terminal.paint('⏺', 'claude')
          : ' '
        : this.mark(worst(call.notes));
      const took =
        call.startedAt === null
          ? ''
          : `  ${formatDuration(call.durationMs ?? Date.now() - call.startedAt)}`;
      return this.line(
        `${mark} ${this.terminal.paint(call.name, 'bold')}(${this.args(call.args, 60)})${this.terminal.paint(took, 'gray')}`,
        1,
      );
    });
  }

  started(listing: SellerListing) {
    const { seller, category, subcategory, images } = listing;
    const about = [
      seller.title,
      `${category}${subcategory ? ` / ${subcategory}` : ''}`,
      `${images.length} image(s)`,
    ].join(' · ');
    this.print([
      `${this.terminal.paint('⏺', this.colour)} ${this.terminal.paint(`Listing ${this.id}`, this.colour, 'bold')} ${this.terminal.paint(about, 'gray')}`,
    ]);
  }

  /** The images are in and the run's state exists: from here its tokens count. */
  loaded(context: RunContext) {
    this.context = context;
    const submitted = context.images.length;
    const loaded = usableImages(context).length;
    const failed = context.images.filter((image) => !image.ok);
    const summary: Note =
      loaded === submitted
        ? { text: `${loaded} of ${submitted} image(s) loaded`, level: 'ok' }
        : loaded === 0
          ? {
              text: `none of ${submitted} image(s) loaded, nothing can be verified visually`,
              level: 'error',
            }
          : {
              text: `${loaded} of ${submitted} image(s) loaded`,
              level: 'warn',
            };
    this.print(
      this.results([
        summary,
        ...failed.map((image): Note => ({
          text: `image ${image.index}: ${image.error}`,
          level: 'warn',
        })),
      ]),
      1,
    );
  }

  passStarted(
    stage: AgentStage,
    model: string,
    effort: LlmReasoningEffort,
    usage: TokenCount,
  ) {
    this.pass = { stage, usage };
    const colour = STAGE_COLOUR[stage];
    this.print([
      `${this.terminal.paint('⏺', colour)} ${this.terminal.paint(STAGE_LABEL[stage], colour, 'bold')} ${this.terminal.paint(`${model} · reasoning ${effort}`, 'gray')}`,
    ]);
  }

  /** The model's reasoning summary for one turn: headlines, or all of it when verbose. */
  reasoning(parts: string[]) {
    const lines = parts.flatMap((part) => {
      const match = HEADLINE.exec(part);
      const body = (match ? part.slice(match[0].length) : part)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const headline = match?.[1].trim() ?? clip(body.shift() ?? '', 100);
      if (!headline) {
        return [];
      }
      return [
        `${this.terminal.paint('✻', 'claude')} ${this.terminal.paint(headline, 'gray', 'italic')}`,
        ...(this.verbose
          ? body.map((line) => this.terminal.paint(`  ${line}`, 'gray'))
          : []),
      ];
    });
    this.print(lines, 1);
  }

  /** The model asked for a tool. Printed with its result, once it returns. */
  toolCalled(callId: string, name: string, args: string) {
    this.call(callId, name).args = args;
  }

  /**
   * Runs one tool call's body: times it, shows it in the live lines while it
   * runs, and keeps what it reports — a failure included — for `toolReturned`.
   * The Agents SDK catches a tool's error and hands the model a generic
   * message, so without this a failed vision or lookup call leaves no trace.
   */
  async tool(
    callId: string | undefined,
    name: string,
    body: (note: ToolNote) => Promise<string>,
  ): Promise<string> {
    const call = this.call(callId ?? `${name}@${Date.now()}`, name);
    const started = Date.now();
    call.startedAt = started;
    try {
      return await body((text, level = 'ok') =>
        call.notes.push({ text, level }),
      );
    } catch (error) {
      call.notes.push({
        text: `failed: ${(error as Error).message}`,
        level: 'error',
      });
      throw error;
    } finally {
      call.durationMs = Date.now() - started;
    }
  }

  /**
   * The SDK handed a tool's output back to the model: prints the call and what
   * it found. The SDK streams outputs only after the turn's tools have all
   * finished, so everything the tool had to report is in by now.
   */
  toolReturned(callId: string, output: unknown) {
    const call = this.calls.get(callId);
    this.calls.delete(callId);
    const notes = call?.notes.length
      ? call.notes
      : [
          {
            text: clip(String(output).split('\n')[0], 160),
            level: 'ok' as const,
          },
        ];
    const took =
      call?.durationMs != null ? `  ${formatDuration(call.durationMs)}` : '';
    this.print(
      [
        `${this.mark(worst(notes))} ${this.terminal.paint(call?.name ?? 'tool', 'bold')}(${this.args(call?.args ?? '', this.verbose ? null : 100)})${this.terminal.paint(took, 'gray')}`,
        ...this.results(notes).map((line) => `  ${line}`),
      ],
      1,
    );
  }

  /** How the pass ended, and what it cost, tool calls included. */
  passEnded(outcome: Note, stats: AgentStageStats) {
    this.pass = null;
    // A call the SDK never reported back on would otherwise blink on forever.
    this.calls.clear();
    const cost = `  ${formatDuration(stats.durationMs)} · ${formatUsage(stats)}`;
    this.print(
      [
        `${this.terminal.paint('⎿  ', 'gray')}${this.terminal.paint(outcome.text, ...LEVEL_STYLE[outcome.level])}${this.terminal.paint(cost, 'gray')}`,
      ],
      1,
    );
  }

  /** A pass that threw. The listing still goes to the verdict gate, which escalates it. */
  failed(stage: string, error: unknown) {
    const { message, stack } = error as Error;
    this.print([
      `${this.mark('error')} ${this.terminal.paint(`${stage} pass failed: ${message}`, 'red')}`,
      ...(stack ?? '')
        .split('\n')
        .slice(1)
        .map((line) => this.terminal.paint(`    ${line.trim()}`, 'gray')),
    ]);
  }

  /** The verdict, as a badge, and why the listing escalated if it did. Closes the trace. */
  finished(verdict: Verdict, reasons: string[]) {
    const published = verdict === 'auto_publish';
    const level: TraceLevel = published ? 'ok' : 'warn';
    const colour = MARK_COLOUR[level];
    const cost = `  ${formatDuration(Date.now() - this.startedAt)} · ${formatUsage(this.usage)} tokens`;
    this.print([
      `${this.terminal.paint(` ${published ? '✔' : '▲'} ${verdict} `, `bg-${colour}`, 'ink', 'bold')}${this.terminal.paint(cost, 'gray')}`,
      ...(published
        ? []
        : this.results(
            (reasons.length > 0
              ? reasons
              : ['The reviewer asked for human review.']
            ).map((text) => ({ text, level })),
          ).map((line) => `  ${line}`)),
    ]);
    this.close();
  }

  /** Takes the listing off the live lines. Safe to call more than once. */
  close() {
    if (!this.done) {
      this.done = true;
      this.onClose(this);
    }
  }

  private call(callId: string, name: string): ToolCall {
    let call = this.calls.get(callId);
    if (!call) {
      call = { name, args: '', notes: [], startedAt: null, durationMs: null };
      this.calls.set(callId, call);
    }
    return call;
  }

  /**
   * A tool call's arguments the way Claude Code shows them, `key: "value"`,
   * cut to `max` characters unless `max` is null.
   */
  private args(args: string, max: number | null): string {
    let shown = args;
    try {
      const parsed: unknown = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        shown = Object.entries(parsed)
          .map(
            ([key, value]) =>
              `${this.terminal.paint(`${key}:`, 'gray')} ${JSON.stringify(value)}`,
          )
          .join(', ');
      }
    } catch {
      // Not JSON: show it as the model sent it.
    }
    return max === null ? shown : fit(shown, max);
  }

  private mark(level: TraceLevel) {
    return this.terminal.paint('⏺', MARK_COLOUR[level]);
  }

  /** `⎿  first` then the rest aligned under it. */
  private results(notes: Note[]): string[] {
    return notes.map(
      (note, index) =>
        `${this.terminal.paint(index === 0 ? '⎿  ' : '   ', 'gray')}${this.terminal.paint(note.text, ...LEVEL_STYLE[note.level])}`,
    );
  }

  private line(text: string, depth = 0) {
    return `${this.gutter}${'  '.repeat(depth)}${text}`;
  }

  private print(lines: string[], depth = 0) {
    this.terminal.print(lines.map((line) => this.line(line, depth)));
  }
}
