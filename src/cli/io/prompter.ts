import type { Readable, Writable } from 'node:stream';
import { autocomplete, autocompleteMultiselect, confirm, isCancel } from '@clack/prompts';

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/** Interactive questions; injected so tests (and non-TTY runs) never block on stdin. */
export interface Prompter {
  confirm(message: string): Promise<boolean>;
  /** Returns the chosen values, or null when cancelled. */
  choose(message: string, choices: readonly Choice[], multiple: boolean): Promise<string[] | null>;
}

export interface Streams {
  readonly input?: Readable;
  readonly output?: Writable;
}

/** @clack/prompts-backed prompter (fuzzy autocomplete when fzf is not installed). */
export function clackPrompter(streams: Streams = {}): Prompter {
  return {
    async confirm(message) {
      const answer = await confirm({ message, initialValue: false, ...streams });
      return !isCancel(answer) && answer;
    },
    async choose(message, choices, multiple) {
      const options = choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint ?? '' }));
      const answer = multiple
        ? await autocompleteMultiselect({ message, options, maxItems: 12, ...streams })
        : await autocomplete({ message, options, maxItems: 12, ...streams });
      if (isCancel(answer)) return null;
      return Array.isArray(answer) ? answer : [answer];
    },
  };
}
