import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  darwinPlatform,
  defaultPlatform,
  type LibSystem,
  miaoYanRunning,
  openLibSystem,
  portablePlatform,
} from '../../src/platform/darwin.ts';
import { tempDir } from '../support/tmp.ts';

let tmp: ReturnType<typeof tempDir>;
let file: string;
beforeEach(() => {
  tmp = tempDir();
  file = join(tmp.path, 'Tiếng Việt – note.md');
  writeFileSync(file, 'x');
});
afterEach(() => tmp.cleanup());

const created = Date.UTC(2021, 2, 4, 5, 6, 7, 890);
const modified = Date.UTC(2024, 10, 12, 13, 14, 15, 160);

describe('darwinPlatform', () => {
  test('sets birth and modification time with ms precision', () => {
    const p = darwinPlatform();
    expect(p.name).toBe('darwin-ffi');
    p.setTimes(file, created, modified);
    const st = statSync(file);
    expect(st.birthtime.getTime()).toBe(created);
    expect(st.mtime.getTime()).toBe(modified);
  });

  test('pins and unpins via xattr; unpinning twice is fine', () => {
    const p = darwinPlatform();
    expect(p.isPinned(file)).toBe(false);
    p.setPinned(file, true);
    expect(p.isPinned(file)).toBe(true);
    p.setPinned(file, false);
    p.setPinned(file, false);
    expect(p.isPinned(file)).toBe(false);
  });

  test('reports failures with errno', () => {
    const p = darwinPlatform();
    const missing = join(tmp.path, 'missing.md');
    expect(() => p.setTimes(missing, created, modified)).toThrow('setattrlist failed');
    expect(() => p.setPinned(missing, true)).toThrow('setxattr failed');
    expect(() => p.setPinned(missing, false)).toThrow('removexattr failed');
  });

  test('errno is 0 when __error returns null', () => {
    const real = openLibSystem();
    const lib = { ...real, setattrlist: () => -1, __error: () => null } as unknown as LibSystem;
    expect(() => darwinPlatform(lib).setTimes(file, 0, 0)).toThrow('errno 0');
  });

  test('isMiaoYanRunning is injectable', () => {
    expect(darwinPlatform(openLibSystem(), () => true).isMiaoYanRunning()).toBe(true);
    expect(typeof miaoYanRunning()).toBe('boolean');
    expect(defaultPlatform().name).toBe('darwin-ffi');
  });
});

describe('portablePlatform', () => {
  test('sets times with two utimes calls and ignores pins', () => {
    const p = portablePlatform();
    p.setTimes(file, created, modified);
    const st = statSync(file);
    expect(st.birthtime.getTime()).toBe(created);
    expect(st.mtime.getTime()).toBe(modified);
    p.setPinned(file, true);
    expect(p.isPinned(file)).toBe(false);
    expect(p.isMiaoYanRunning()).toBe(false);
    expect(portablePlatform(() => true).isMiaoYanRunning()).toBe(true);
  });
});
