#!/usr/bin/env bun
import { homedir, tmpdir } from 'node:os';
import { run } from './cli/run.ts';
import { defaultPlatform } from './platform/darwin.ts';

const controller = new AbortController();
let interrupts = 0;
process.on('SIGINT', () => {
  interrupts += 1;
  if (interrupts > 1) process.exit(130);
  controller.abort(new Error('interrupted'));
});

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  home: homedir(),
  stdout: process.stdout,
  stderr: process.stderr,
  stdoutTTY: process.stdout.isTTY === true,
  stderrTTY: process.stderr.isTTY === true,
  platform: defaultPlatform(),
  fetch,
  signal: controller.signal,
  now: Date.now,
  which: (bin) => Bun.which(bin),
  tmpDir: tmpdir(),
});
