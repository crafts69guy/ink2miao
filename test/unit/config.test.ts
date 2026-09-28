import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInkdropServer } from '../../src/config/inkdrop.ts';
import { loadConfig, statePath } from '../../src/config/load.ts';
import { expandHome, xdgPaths } from '../../src/config/paths.ts';
import { CliError } from '../../src/util/errors.ts';
import { tempDir } from '../support/tmp.ts';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

describe('paths', () => {
  test('XDG env overrides and fallbacks', () => {
    expect(xdgPaths({}, '/h').configDir).toBe('/h/.config/ink2miao');
    const p = xdgPaths({ XDG_STATE_HOME: '/s', XDG_DATA_HOME: '', XDG_CONFIG_HOME: '/c' }, '/h');
    expect(p).toEqual({
      home: '/h',
      configDir: '/c/ink2miao',
      stateDir: '/s/ink2miao',
      dataDir: '/h/.local/share/ink2miao',
    });
  });
  test('expandHome', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/x', '/h')).toBe('/h/x');
    expect(expandHome('/abs', '/h')).toBe('/abs');
  });
});

describe('loadConfig', () => {
  test('defaults', () => {
    const c = loadConfig({ env: {}, home: tmp.path, flags: {} });
    expect(c.file).toBeNull();
    expect(c.config).toMatchObject({
      profile: 'default',
      linkMode: 'auto',
      includeTrash: true,
      deletedFolder: '_Inkdrop Deleted',
      concurrency: 4,
    });
    expect(c.config.staging).toBe(join(tmp.path, '.local/share/ink2miao/default/staging'));
    expect(c.config.target).toContain('iCloud~com~tw93~miaoyan');
    expect(Object.values(c.origins).every((o) => o === 'default')).toBe(true);
    expect(statePath(c)).toBe(join(tmp.path, '.local/state/ink2miao/default/state.db'));
  });

  test('precedence flags > env > file, with coercion and ~ expansion', () => {
    const file = join(tmp.path, 'config.toml');
    writeFileSync(
      file,
      'profile = "work"\nstaging = "~/stage"\nlink_mode = "goto"\nconcurrency = 2\ninclude_trash = false\n',
    );
    const c = loadConfig({
      env: {
        INK2MIAO_LINK_MODE: 'wikilink',
        INK2MIAO_CONCURRENCY: '8',
        INK2MIAO_INCLUDE_TRASH: 'yes',
      },
      home: tmp.path,
      configFile: file,
      flags: { concurrency: '16', profile: undefined },
    });
    expect(c.file).toBe(file);
    expect(c.config.profile).toBe('work');
    expect(c.config.staging).toBe(join(tmp.path, 'stage'));
    expect(c.config.linkMode).toBe('wikilink');
    expect(c.config.concurrency).toBe(16);
    expect(c.config.includeTrash).toBe(true);
    expect(c.origins).toMatchObject({ profile: 'file', linkMode: 'env', concurrency: 'flag' });
  });

  test('reads the XDG config file implicitly', () => {
    const dir = join(tmp.path, '.config/ink2miao');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.toml'), 'deleted_folder = "_Archive"\n');
    const c = loadConfig({ env: {}, home: tmp.path, flags: {} });
    expect(c.config.deletedFolder).toBe('_Archive');
  });

  test.each([
    [{ deletedFolder: 'My Trash' }, 'deletedFolder'],
    [{ deletedFolder: '.hidden' }, 'deletedFolder'],
    [{ trashReplacement: 'trash2' }, 'trashReplacement'],
    [{ linkMode: 'weird' }, 'linkMode'],
    [{ concurrency: '0' }, 'concurrency'],
    [{ profile: 'a b' }, 'profile'],
    [{ includeTrash: 'maybe' }, 'includeTrash'],
  ])('rejects %j', (flags, key) => {
    expect(() => loadConfig({ env: {}, home: tmp.path, flags })).toThrow(key);
  });

  test('missing explicit file and unreadable TOML are usage errors', () => {
    expect(() =>
      loadConfig({ env: {}, home: tmp.path, configFile: join(tmp.path, 'nope.toml'), flags: {} }),
    ).toThrow(CliError);
    const bad = join(tmp.path, 'bad.toml');
    writeFileSync(bad, 'this is = = not toml');
    expect(() => loadConfig({ env: {}, home: tmp.path, configFile: bad, flags: {} })).toThrow(
      'cannot read config',
    );
  });
});

describe('resolveInkdropServer', () => {
  const write = (server: unknown) => {
    const p = join(tmp.path, 'config.json');
    writeFileSync(p, JSON.stringify({ '*': { core: { server } } }));
    return p;
  };

  test('env triple wins without reading the file', () => {
    const s = resolveInkdropServer(
      {
        INKDROP_LOCAL_SERVER_URL: 'http://x',
        INKDROP_LOCAL_USERNAME: 'u',
        INKDROP_LOCAL_PASSWORD: 'p',
      },
      '/nonexistent',
    );
    expect(s).toEqual({ url: 'http://x', username: 'u', password: 'p', origin: 'env' });
  });

  test('reads plain auth from Inkdrop config', () => {
    const p = write({
      enabled: true,
      port: 1234,
      bindAddress: '0.0.0.0',
      auth: { username: 'a', password: 'b' },
    });
    expect(resolveInkdropServer({}, p)).toEqual({
      url: 'http://0.0.0.0:1234',
      username: 'a',
      password: 'b',
      origin: 'inkdrop-config',
    });
  });

  test('defaults address/port and lets env fill encrypted auth', () => {
    const p = write({ enabled: true, auth: 'encrypted-blob' });
    const s = resolveInkdropServer({ INKDROP_LOCAL_USERNAME: 'u', INKDROP_LOCAL_PASSWORD: 'p' }, p);
    expect(s).toEqual({
      url: 'http://127.0.0.1:19840',
      username: 'u',
      password: 'p',
      origin: 'env',
    });
    expect(() => resolveInkdropServer({}, p)).toThrow('encrypted or missing');
  });

  test('disabled, missing or unreadable config', () => {
    expect(() => resolveInkdropServer({}, write({ enabled: false }))).toThrow('not enabled');
    const empty = join(tmp.path, 'empty.json');
    writeFileSync(empty, JSON.stringify({ '*': 42 }));
    expect(() => resolveInkdropServer({}, empty)).toThrow('not enabled');
    expect(() => resolveInkdropServer({}, join(tmp.path, 'none.json'))).toThrow(
      'cannot read Inkdrop config',
    );
  });
});
