export interface Platform {
  readonly name: string;
  /** Sets creation (birth) and modification times, in epoch milliseconds. */
  setTimes(path: string, createdMs: number, modifiedMs: number): void;
  /** MiaoYan pin flag (xattr `com.tw93.miaoyan.pin`). */
  setPinned(path: string, pinned: boolean): void;
  isPinned(path: string): boolean;
  isMiaoYanRunning(): boolean;
}

export const PIN_XATTR = 'com.tw93.miaoyan.pin';
