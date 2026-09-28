import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diskState, UNREADABLE } from '../../src/apply/disk.ts';
import { acquireLock } from '../../src/state/lock.ts';
import { CliError } from '../../src/util/errors.ts';
import { tempDir } from '../support/tmp.ts';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

test('lock is exclusive while the owner lives and released afterwards', () => {
  const path = join(tmp.path, 'p/lock');
  const lock = acquireLock(path);
  expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
  const other = Bun.spawn(['sleep', '5']);
  try {
    writeFileSync(path, String(other.pid));
    expect(() => acquireLock(path)).toThrow(CliError);
  } finally {
    other.kill();
  }
  writeFileSync(path, String(process.pid));
  lock.release();
  acquireLock(path).release();
});

test('stale and garbage locks are taken over; foreign live pids are respected', () => {
  const path = join(tmp.path, 'lock');
  writeFileSync(path, '999999');
  acquireLock(path).release();
  writeFileSync(path, 'garbage');
  acquireLock(path).release();
  // pid 1 exists but belongs to root: EPERM still means "alive".
  writeFileSync(path, '1');
  expect(() => acquireLock(path)).toThrow('pid 1');
});

test('lock creation errors other than EEXIST propagate', () => {
  writeFileSync(join(tmp.path, 'file'), '');
  expect(() => acquireLock(join(tmp.path, 'file/lock'))).toThrow();
});

test('diskState hashes lazily and distinguishes missing from unreadable', () => {
  writeFileSync(join(tmp.path, 'a.md'), 'hello');
  mkdirSync(join(tmp.path, 'dir.md'));
  const d = diskState(tmp.path);
  expect(d.md5('a.md')).toBe('5d41402abc4b2a76b9719d911017c592');
  expect(d.sha256('a.md')).toHaveLength(64);
  expect(d.sha256('missing.md')).toBeNull();
  expect(d.sha256('dir.md')).toBe(UNREADABLE);
  expect(d.md5('dir.md')).toBe(UNREADABLE);
});
