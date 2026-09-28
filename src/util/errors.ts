export const ExitCode = {
  Ok: 0,
  Internal: 1,
  Usage: 2,
  Source: 3,
  Conflict: 4,
  VerifyFailed: 5,
  MiaoYanRunning: 6,
  Pending: 10,
  Interrupted: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** An expected failure with a user-facing message and a specific exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
