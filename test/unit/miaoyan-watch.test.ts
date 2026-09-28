import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { miaoyanLibrary, spawnText } from '../../src/platform/miaoyan.ts';
import { waitForChange } from '../../src/util/watch.ts';
import { tempDir } from '../support/tmp.ts';

describe('miaoyanLibrary', () => {
  test('reads paths and file URLs, trying both preference domains', () => {
    const calls: string[] = [];
    const lib = miaoyanLibrary((cmd) => {
      calls.push(cmd[2] as string);
      return cmd[2] === 'com.tw93.MiaoYan'
        ? { success: true, stdout: 'file:///Users/me/Notes%20Lib/\n' }
        : { success: false, stdout: '' };
    });
    expect(lib).toBe('/Users/me/Notes Lib/');
    expect(calls).toEqual(['com.tw93.miaoyan', 'com.tw93.MiaoYan']);
    expect(miaoyanLibrary(() => ({ success: true, stdout: '/plain/path\n' }))).toBe('/plain/path');
    expect(miaoyanLibrary(() => ({ success: true, stdout: '  ' }))).toBeNull();
  });

  test('spawnText runs a real command', () => {
    expect(spawnText(['echo', 'hi'])).toEqual({ success: true, stdout: 'hi\n' });
    expect(typeof miaoyanLibrary()).not.toBe('undefined');
  });
});

describe('waitForChange', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.cleanup());

  test('resolves after a debounced change and ignores our temp files', async () => {
    const ctl = new AbortController();
    let resolved = false;
    const p = waitForChange(tmp.path, 30, ctl.signal).then(() => {
      resolved = true;
    });
    await Bun.sleep(20);
    writeFileSync(join(tmp.path, '.ink2miao-abc.tmp'), 'x');
    await Bun.sleep(80);
    expect(resolved).toBe(false);
    writeFileSync(join(tmp.path, 'note.md'), 'x');
    await p;
    expect(resolved).toBe(true);
  });

  test('rejects when aborted before or while waiting', async () => {
    const pre = new AbortController();
    pre.abort(new Error('pre'));
    await expect(waitForChange(tmp.path, 10, pre.signal)).rejects.toThrow('pre');
    const mid = new AbortController();
    const p = waitForChange(tmp.path, 10, mid.signal);
    mid.abort(new Error('mid'));
    await expect(p).rejects.toThrow('mid');
  });
});
