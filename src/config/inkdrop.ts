import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CliError, ExitCode, errorMessage } from '../util/errors.ts';
import type { Env } from './paths.ts';

export interface InkdropServer {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly origin: 'env' | 'inkdrop-config';
}

const ServerSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().optional(),
  bindAddress: z.string().optional(),
  auth: z.union([z.object({ username: z.string(), password: z.string() }), z.string()]).optional(),
});

const InkdropConfigSchema = z.object({
  '*': z.object({ core: z.object({ server: ServerSchema.optional() }).optional() }).optional(),
});

type ServerConfig = z.infer<typeof ServerSchema>;

function readServerConfig(path: string): ServerConfig | null {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new CliError(`cannot read Inkdrop config ${path}: ${errorMessage(e)}`, ExitCode.Source);
  }
  const parsed = InkdropConfigSchema.safeParse(json);
  return parsed.success ? (parsed.data['*']?.core?.server ?? null) : null;
}

/**
 * Credentials for Inkdrop's local server. The same env vars as `@inkdropapp/mcp-server` win;
 * otherwise they are read from Inkdrop's own config.json (never copied or printed).
 */
export function resolveInkdropServer(env: Env, inkdropConfigPath: string): InkdropServer {
  const envUrl = env['INKDROP_LOCAL_SERVER_URL'];
  const envUser = env['INKDROP_LOCAL_USERNAME'];
  const envPass = env['INKDROP_LOCAL_PASSWORD'];
  if (envUrl && envUser && envPass) {
    return { url: envUrl, username: envUser, password: envPass, origin: 'env' };
  }

  const server = readServerConfig(inkdropConfigPath);
  if (!server || server.enabled === false) {
    throw new CliError(
      'Inkdrop local server is not enabled',
      ExitCode.Source,
      'enable it in Inkdrop → Preferences → Integrations/Local Server',
    );
  }
  const auth = typeof server.auth === 'object' ? server.auth : null;
  const username = envUser ?? auth?.username;
  const password = envPass ?? auth?.password;
  if (!username || !password) {
    throw new CliError(
      'Inkdrop server credentials are encrypted or missing',
      ExitCode.Source,
      'set INKDROP_LOCAL_USERNAME and INKDROP_LOCAL_PASSWORD',
    );
  }
  const url = envUrl ?? `http://${server.bindAddress ?? '127.0.0.1'}:${server.port ?? 19840}`;
  return { url, username, password, origin: envUser || envPass ? 'env' : 'inkdrop-config' };
}
