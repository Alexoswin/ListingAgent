/**
 * The terminal the agent trace is drawn on.
 *
 * Output is whole lines, appended, so a trace reads the same in a log file as
 * on screen. On an interactive terminal it also gets colour — 24-bit where the
 * terminal has it, the nearest of 256 or 16 colours where it does not — and a
 * few live lines pinned below the output, redrawn in place until they are
 * unpinned: a spinner, a shimmer across what is running, and marks that blink
 * while their work is in flight, the way Claude Code draws a session.
 */

const MODIFIERS = { bold: '1', dim: '2', italic: '3' } as const;

/** Each colour as RGB, with the basic ANSI code a 16-colour terminal gets. */
const COLOURS = {
  /** Claude Code's orange: whatever is running now. */
  claude: { rgb: [215, 119, 87], basic: 33 },
  /** The lighter band that sweeps across it. */
  shimmer: { rgb: [245, 185, 155], basic: 93 },
  green: { rgb: [78, 186, 101], basic: 32 },
  red: { rgb: [255, 107, 128], basic: 31 },
  yellow: { rgb: [255, 193, 7], basic: 33 },
  blue: { rgb: [122, 162, 247], basic: 34 },
  cyan: { rgb: [86, 182, 194], basic: 36 },
  purple: { rgb: [175, 135, 255], basic: 35 },
  pink: { rgb: [253, 93, 177], basic: 95 },
  gray: { rgb: [140, 140, 140], basic: 90 },
  /** Dark text, for reading on a coloured background. */
  ink: { rgb: [24, 24, 24], basic: 30 },
} as const satisfies Record<
  string,
  { rgb: readonly [number, number, number]; basic: number }
>;

export type Colour = keyof typeof COLOURS;
export type Style = keyof typeof MODIFIERS | Colour | `bg-${Colour}`;

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
/**
 * One redraw. The shimmer moves a character a tick, the spinner turns every
 * other tick, and a blinking mark changes every eighth.
 */
const TICK_MS = 60;
/** Wraps a redraw so a terminal that supports it paints it all at once. */
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
// Matching the escape character is the point of these two.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/y;
// eslint-disable-next-line no-control-regex
const ANSI_ALL = /\x1b\[[0-9;]*m/g;

type Write = typeof process.stdout.write;

/** What one redraw of the live lines has to draw with. */
export interface Frame {
  /** The spinner glyph, painted. */
  spinner: string;
  /** Whether a blinking mark is lit on this redraw. */
  lit: boolean;
  /** Paints text in Claude orange, with a lighter band sweeping across it. */
  shimmer(text: string): string;
}

/** The live lines, drawn fresh for every frame. The last one is the status line. */
export type LiveView = (frame: Frame) => string[];

export class Terminal {
  private readonly stream = process.stdout;
  /** A pipe or a log file gets plain lines: no colour, no live lines. */
  readonly interactive = this.stream.isTTY === true;
  /** Bits of colour: 1 for none, 4, 8, or 24. Honours NO_COLOR and FORCE_COLOR. */
  private readonly depth = this.interactive
    ? (this.stream.getColorDepth?.() ?? 1)
    : 1;
  private readonly colour = this.depth >= 4;

  private view: LiveView | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tick = 0;
  /** How many live lines are on screen now. */
  private shown = 0;
  /** Whether the last write ended a line; the live lines only go on a fresh one. */
  private atLineStart = true;
  /** The unpatched writer, for drawing the live lines themselves. */
  private raw: ((text: string) => void) | null = null;
  private restore: (() => void)[] = [];

  /**
   * Styles one span. Spans do not nest: each one resets every style it set.
   * Bound, so it can be taken off the terminal: `const { paint } = terminal`.
   */
  readonly paint = (text: string, ...styles: Style[]): string => {
    if (!this.colour || !text || styles.length === 0) {
      return text;
    }
    return `\x1b[${styles.map((style) => this.code(style)).join(';')}m${text}\x1b[0m`;
  };

  /** Writes whole lines, above the live lines when they are pinned. */
  print(lines: string[]) {
    this.stream.write(lines.map((line) => `${line}\n`).join(''));
  }

  /** Draws a rounded box around lines, the way Claude Code frames its welcome. */
  box(lines: string[], border: Colour): string[] {
    const width = Math.max(...lines.map(visibleLength));
    const edge = (left: string, right: string) =>
      this.paint(`${left}${'─'.repeat(width + 2)}${right}`, border);
    const side = this.paint('│', border);
    return [
      edge('╭', '╮'),
      ...lines.map(
        (line) =>
          `${side} ${line}${' '.repeat(width - visibleLength(line))} ${side}`,
      ),
      edge('╰', '╯'),
    ];
  }

  /**
   * Pins live lines below the output until `unpin`, or swaps the view already
   * pinned. Does nothing when the output is not a terminal.
   *
   * Every write to stdout and stderr goes around them while they are pinned,
   * not only the trace's own: a Nest log line printed mid-run would otherwise
   * be written over them.
   */
  pin(view: LiveView) {
    if (!this.interactive) {
      return;
    }
    const pinned = this.view !== null;
    this.view = view;
    if (pinned) {
      return;
    }

    const write = this.stream.write.bind(this.stream) as Write;
    this.raw = (text) => write(text);
    this.restore = [this.hook(process.stdout), this.hook(process.stderr)];
    this.timer = setInterval(() => {
      this.tick += 1;
      this.draw();
    }, TICK_MS);
    // An animation must never be what keeps the process alive.
    this.timer.unref();
    this.draw();
  }

  unpin() {
    if (!this.view) {
      return;
    }
    this.clear();
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.restore.forEach((restore) => restore());
    this.restore = [];
    this.timer = null;
    this.raw = null;
    this.view = null;
  }

  private code(style: Style): string {
    if (style in MODIFIERS) {
      return MODIFIERS[style as keyof typeof MODIFIERS];
    }
    const background = style.startsWith('bg-');
    const { rgb, basic } =
      COLOURS[(background ? style.slice(3) : style) as Colour];
    const layer = background ? 48 : 38;
    if (this.depth >= 24) {
      return `${layer};2;${rgb.join(';')}`;
    }
    if (this.depth >= 8) {
      return `${layer};5;${ansi256(rgb)}`;
    }
    return `${basic + (background ? 10 : 0)}`;
  }

  /** Claude Code's glimmer: a three-character band crossing the text, then a pause. */
  private shimmer(text: string, tick: number): string {
    if (!this.colour) {
      return text;
    }
    const chars = [...text];
    const centre = (tick % (chars.length + 12)) - 4;
    let out = '';
    let run = '';
    let lit = false;
    chars.forEach((char, index) => {
      const glow = Math.abs(index - centre) <= 1;
      if (glow !== lit && run) {
        out += this.paint(run, lit ? 'shimmer' : 'claude');
        run = '';
      }
      lit = glow;
      run += char;
    });
    return out + this.paint(run, lit ? 'shimmer' : 'claude');
  }

  private frame(): Frame {
    const tick = this.tick;
    return {
      spinner: this.paint(
        SPINNER[Math.floor(tick / 2) % SPINNER.length],
        'claude',
      ),
      lit: Math.floor(tick / 8) % 2 === 0,
      shimmer: (text) => this.shimmer(text, tick),
    };
  }

  /** Routes a stream's writes around the live lines; returns the undo. */
  private hook(stream: NodeJS.WriteStream): () => void {
    // Kept only to be put back as it was; calls go through `write`.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = stream.write;
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      this.clear();
      const written = write(chunk, ...rest);
      this.atLineStart = endsLine(chunk);
      this.draw();
      return written;
    };
    return () => {
      stream.write = original;
    };
  }

  private draw() {
    if (!this.view || !this.raw || !this.atLineStart) {
      return;
    }
    // Each cut to one row: a line that wraps would leave its first half behind
    // when it is erased. And no more rows than the screen has, since the cursor
    // cannot climb back past its top to erase them.
    const width = (this.stream.columns || 80) - 1;
    const height = Math.max(1, (this.stream.rows || 24) - 1);
    const lines = this.view(this.frame())
      .slice(-height)
      .map((line) => fit(line, width));
    // One write, erase and all, so a redraw never shows half-drawn.
    this.raw(`${SYNC_START}${this.erase()}${lines.join('\n')}${SYNC_END}`);
    this.shown = lines.length;
  }

  /** Erases the live lines, leaving the cursor where the first one began. */
  private erase(): string {
    if (this.shown === 0) {
      return '';
    }
    const up = this.shown > 1 ? `\x1b[${this.shown - 1}A` : '';
    return `\r${up}\x1b[J`;
  }

  private clear() {
    if (this.shown > 0 && this.raw) {
      this.raw(this.erase());
      this.shown = 0;
    }
  }
}

const endsLine = (chunk: string | Uint8Array) =>
  typeof chunk === 'string'
    ? chunk.endsWith('\n')
    : chunk[chunk.length - 1] === 0x0a;

/** The nearest colour in the 256-colour cube. */
const ansi256 = ([red, green, blue]: readonly number[]) =>
  16 +
  36 * Math.round((red / 255) * 5) +
  6 * Math.round((green / 255) * 5) +
  Math.round((blue / 255) * 5);

const visibleLength = (text: string) => [...text.replace(ANSI_ALL, '')].length;

/** Cuts styled text to `width` visible characters, keeping its styles intact. */
export function fit(text: string, width: number): string {
  if (visibleLength(text) <= width) {
    return text;
  }
  let out = '';
  let visible = 0;
  for (let i = 0; visible < width - 1;) {
    ANSI.lastIndex = i;
    const style = ANSI.exec(text);
    if (style) {
      out += style[0];
      i += style[0].length;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i) as number);
    out += char;
    i += char.length;
    visible += 1;
  }
  // The reset closes a style the cut left open; plain text needs none.
  return `${out}…${text.includes('\x1b[') ? '\x1b[0m' : ''}`;
}
