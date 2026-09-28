import { z } from 'zod';

const bool = z.union([
  z.boolean(),
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .transform((v) => ['true', '1', 'yes'].includes(v)),
]);

const folderName = z
  .string()
  .min(1)
  .refine((s) => !/trash/i.test(s), 'must not contain "Trash" (MiaoYan hides such folders)')
  .refine((s) => !s.startsWith('.') && !s.includes('/'), 'must be a single visible folder name');

export const ConfigSchema = z.object({
  profile: z.string().regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, - and _ only'),
  staging: z.string().min(1),
  target: z.string().min(1),
  linkMode: z.enum(['auto', 'wikilink', 'goto']),
  includeTrash: bool,
  deletedFolder: folderName,
  trashReplacement: z.string().refine((s) => !/trash/i.test(s), 'must not contain "Trash"'),
  concurrency: z.coerce.number().int().min(1).max(32),
  deletions: z.enum(['move', 'keep', 'delete']),
  inkdropConfig: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigKey = keyof Config;

/** TOML key and environment variable for every setting. */
export const CONFIG_KEYS: Readonly<Record<ConfigKey, { toml: string; env: string }>> = {
  profile: { toml: 'profile', env: 'INK2MIAO_PROFILE' },
  staging: { toml: 'staging', env: 'INK2MIAO_STAGING' },
  target: { toml: 'target', env: 'INK2MIAO_TARGET' },
  linkMode: { toml: 'link_mode', env: 'INK2MIAO_LINK_MODE' },
  includeTrash: { toml: 'include_trash', env: 'INK2MIAO_INCLUDE_TRASH' },
  deletedFolder: { toml: 'deleted_folder', env: 'INK2MIAO_DELETED_FOLDER' },
  trashReplacement: { toml: 'trash_replacement', env: 'INK2MIAO_TRASH_REPLACEMENT' },
  concurrency: { toml: 'concurrency', env: 'INK2MIAO_CONCURRENCY' },
  deletions: { toml: 'deletions', env: 'INK2MIAO_DELETIONS' },
  inkdropConfig: { toml: 'inkdrop_config', env: 'INK2MIAO_INKDROP_CONFIG' },
};
