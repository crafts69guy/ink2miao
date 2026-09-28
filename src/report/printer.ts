import { createColors } from 'picocolors';

export interface Writer {
  write(chunk: string): void;
}

export interface PrinterOptions {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly color: boolean;
  /** stderr is an interactive terminal: enables the transient progress line. */
  readonly tty: boolean;
}

export type Colors = ReturnType<typeof createColors>;

/**
 * Output policy: results go to stdout, diagnostics to stderr; `--json` switches stdout to
 * NDJSON events and silences human text.
 */
export class Printer {
  readonly c: Colors;
  #progressShown = false;

  constructor(
    readonly out: Writer,
    readonly err: Writer,
    readonly opts: PrinterOptions,
  ) {
    this.c = createColors(opts.color && !opts.json);
  }

  /** Primary human output (stdout). */
  line(text = ''): void {
    if (this.opts.json) return;
    this.#clearProgress();
    this.out.write(`${text}\n`);
  }

  info(text: string): void {
    if (this.opts.json || this.opts.quiet) return;
    this.#clearProgress();
    this.err.write(`${text}\n`);
  }

  debug(text: string): void {
    if (this.opts.verbose) this.info(this.c.dim(text));
  }

  warn(text: string): void {
    if (this.opts.json) return;
    this.#clearProgress();
    this.err.write(`${this.c.yellow('!')} ${text}\n`);
  }

  error(text: string, hint: string | null = null): void {
    if (this.opts.json) {
      this.event('error', { message: text, hint });
      return;
    }
    this.#clearProgress();
    this.err.write(`${this.c.red('✗')} ${text}\n`);
    if (hint) this.err.write(`  ${this.c.dim(hint)}\n`);
  }

  /** Structured event; only emitted in `--json` mode. */
  event(type: string, data: Record<string, unknown> = {}): void {
    if (this.opts.json) this.out.write(`${JSON.stringify({ type, ...data })}\n`);
  }

  progress(label: string, done: number, total: number): void {
    if (this.opts.json || this.opts.quiet || !this.opts.tty) return;
    this.err.write(`\r\x1b[2K${this.c.dim(`${label} ${done}/${total}`)}`);
    this.#progressShown = true;
  }

  #clearProgress(): void {
    if (!this.#progressShown) return;
    this.err.write('\r\x1b[2K');
    this.#progressShown = false;
  }
}

/** OSC 8 terminal hyperlink to a local file (plain text when not a TTY). */
export function fileLink(path: string, label: string, tty: boolean): string {
  if (!tty) return label;
  const url = `file://${path.split('/').map(encodeURIComponent).join('/')}`;
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}
