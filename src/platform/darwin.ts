import { dlopen, FFIType, ptr, read } from 'bun:ffi';
import { utimesSync } from 'node:fs';
import { PIN_XATTR, type Platform } from './types.ts';

const ATTR_BIT_MAP_COUNT = 5;
const ATTR_CMN_CRTIME = 0x200;
const ATTR_CMN_MODTIME = 0x400;
const ENOATTR = 93;

const cstr = (s: string) => Buffer.from(`${s}\0`, 'utf8');

function timespec(view: DataView, offset: number, ms: number): void {
  view.setBigInt64(offset, BigInt(Math.floor(ms / 1000)), true);
  view.setBigInt64(offset + 8, BigInt(Math.round(ms % 1000) * 1_000_000), true);
}

export type LibSystem = ReturnType<typeof openLibSystem>;

export function openLibSystem() {
  return dlopen('/usr/lib/libSystem.B.dylib', {
    setattrlist: {
      args: [FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32],
      returns: FFIType.i32,
    },
    setxattr: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32],
      returns: FFIType.i32,
    },
    getxattr: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32],
      returns: FFIType.i64,
    },
    removexattr: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  }).symbols;
}

function errno(lib: LibSystem): number {
  const p = lib.__error();
  return p === null ? 0 : read.i32(p, 0);
}

/**
 * macOS implementation over libSystem via `bun:ffi`: `setattrlist` sets birth + mod time in
 * one call (ms precision), and the pin flag is the one-byte xattr MiaoYan reads.
 */
export function darwinPlatform(
  lib: LibSystem = openLibSystem(),
  running: () => boolean = miaoYanRunning,
): Platform {
  return {
    name: 'darwin-ffi',
    setTimes(path, createdMs, modifiedMs) {
      const attrs = new DataView(new ArrayBuffer(24));
      attrs.setUint16(0, ATTR_BIT_MAP_COUNT, true);
      attrs.setUint32(4, ATTR_CMN_CRTIME | ATTR_CMN_MODTIME, true);
      const times = new DataView(new ArrayBuffer(32));
      timespec(times, 0, createdMs);
      timespec(times, 16, modifiedMs);
      if (lib.setattrlist(cstr(path), ptr(attrs.buffer), ptr(times.buffer), 32n, 0) !== 0) {
        throw new Error(`setattrlist failed for ${path} (errno ${errno(lib)})`);
      }
    },
    setPinned(path, pinned) {
      if (pinned) {
        const one = new Uint8Array([1]);
        if (lib.setxattr(cstr(path), cstr(PIN_XATTR), ptr(one), 1n, 0, 0) !== 0) {
          throw new Error(`setxattr failed for ${path} (errno ${errno(lib)})`);
        }
      } else if (lib.removexattr(cstr(path), cstr(PIN_XATTR), 0) !== 0) {
        const code = errno(lib);
        if (code !== ENOATTR) throw new Error(`removexattr failed for ${path} (errno ${code})`);
      }
    },
    isPinned(path) {
      const out = new Uint8Array(1);
      return lib.getxattr(cstr(path), cstr(PIN_XATTR), ptr(out), 1n, 0, 0) === 1n && out[0] === 1;
    },
    isMiaoYanRunning: running,
  };
}

export function miaoYanRunning(): boolean {
  return Bun.spawnSync(['pgrep', '-x', 'MiaoYan'], { stdout: 'ignore', stderr: 'ignore' }).success;
}

/**
 * Portable fallback: setting an mtime older than the birth time moves APFS's birth time back,
 * so two `utimes` calls set both. Pins are not supported.
 */
export function portablePlatform(running: () => boolean = () => false): Platform {
  return {
    name: 'portable-utimes',
    setTimes(path, createdMs, modifiedMs) {
      utimesSync(path, new Date(createdMs), new Date(createdMs));
      utimesSync(path, new Date(), new Date(modifiedMs));
    },
    setPinned() {},
    isPinned: () => false,
    isMiaoYanRunning: running,
  };
}

export function defaultPlatform(): Platform {
  return process.platform === 'darwin' ? darwinPlatform() : portablePlatform();
}
