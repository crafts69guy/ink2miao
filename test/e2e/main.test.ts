import { expect, test } from 'bun:test';
import { join } from 'node:path';

const main = join(import.meta.dir, '../../src/main.ts');

test('the entrypoint runs and sets the exit code', () => {
  const ok = Bun.spawnSync(['bun', main, '--version']);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString().trim()).toBe('0.1.0');
  const bad = Bun.spawnSync(['bun', main, 'nope']);
  expect(bad.exitCode).toBe(2);
});
