export interface ExecOptions {
  /** Written to the child's stdin; otherwise stdin is inherited (interactive tools). */
  readonly input?: string;
  /** Capture stdout instead of inheriting the terminal. */
  readonly capture?: boolean;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Runs an external tool (fzf, glow, delta, chafa, open). Injected so tests never spawn. */
export type Exec = (cmd: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

export const bunExec: Exec = async (cmd, opts = {}) => {
  const child = Bun.spawn([...cmd], {
    stdin: opts.input === undefined ? 'inherit' : new Blob([opts.input]),
    stdout: opts.capture ? 'pipe' : 'inherit',
    stderr: 'inherit',
  });
  const stdout = opts.capture ? await new Response(child.stdout).text() : '';
  return { exitCode: await child.exited, stdout };
};

/** Quotes one argument for `sh -c` (fzf runs its preview command through the shell). */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}
