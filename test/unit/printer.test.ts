import { describe, expect, test } from 'bun:test';
import { makePrinter } from '../../src/cli/context.ts';
import { fileLink, Printer, type PrinterOptions, progressBar } from '../../src/report/printer.ts';

function capture(opts: Partial<PrinterOptions> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const p = new Printer(
    { write: (s) => void out.push(s) },
    { write: (s) => void err.push(s) },
    { json: false, quiet: false, verbose: false, color: false, tty: false, ...opts },
  );
  return { p, out, err };
}

describe('Printer', () => {
  test('human mode routes output and diagnostics', () => {
    const { p, out, err } = capture({ verbose: true });
    p.line('result');
    p.line();
    p.info('info');
    p.debug('debug');
    p.warn('careful');
    p.error('bad', 'hint');
    p.error('bad2');
    p.event('ignored');
    p.progress('x', 1, 2);
    expect(out).toEqual(['result\n', '\n']);
    expect(err).toEqual(['info\n', 'debug\n', '! careful\n', '✗ bad\n', '  hint\n', '✗ bad2\n']);
  });

  test('quiet hides info and debug', () => {
    const { p, err } = capture({ quiet: true });
    p.info('x');
    p.debug('y');
    p.warn('w');
    expect(err).toEqual(['! w\n']);
  });

  test('json mode only emits events', () => {
    const { p, out, err } = capture({ json: true });
    p.line('x');
    p.info('x');
    p.warn('x');
    p.progress('x', 1, 1);
    p.event('done', { n: 1 });
    p.error('boom', null);
    expect(err).toEqual([]);
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { type: 'done', n: 1 },
      { type: 'error', message: 'boom', hint: null },
    ]);
  });

  test('tty progress line is cleared before the next message', () => {
    const { p, err } = capture({ tty: true, color: true });
    p.progress('writing', 1, 3);
    p.info('next');
    expect(err[0]).toContain('writing 1/3');
    expect(err[0]).toContain('33%');
    expect(err[1]).toBe('\r\x1b[2K');
    expect(err[2]).toBe('next\n');
  });
});

test('progressBar', () => {
  expect(progressBar(5, 10, 10)).toBe('█████░░░░░  50%');
  expect(progressBar(0, 0, 4)).toBe('░░░░   0%');
  expect(progressBar(9, 3, 4)).toBe('████ 100%');
});

test('fileLink emits OSC 8 only on a TTY', () => {
  expect(fileLink('/a b/c.md', 'label', false)).toBe('label');
  expect(fileLink('/a b/c.md', 'label', true)).toBe(
    '\x1b]8;;file:///a%20b/c.md\x07label\x1b]8;;\x07',
  );
});

test('makePrinter honours NO_COLOR, TERM=dumb and --no-color', () => {
  const base = {
    stdout: { write() {} },
    stderr: { write() {} },
    stderrTTY: true,
  } as unknown as Parameters<typeof makePrinter>[0];
  const colored = (env: Record<string, string>, color?: boolean) =>
    makePrinter({ ...base, env } as never, { color }).opts.color;
  expect(colored({})).toBe(true);
  expect(colored({ NO_COLOR: '1' })).toBe(false);
  expect(colored({ NO_COLOR: '' })).toBe(true);
  expect(colored({ TERM: 'dumb' })).toBe(false);
  expect(colored({}, false)).toBe(false);
});
