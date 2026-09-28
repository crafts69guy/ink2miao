import { z } from 'zod';
import { NOTE_STATUSES } from '../domain/model.ts';

const millis = z.number().finite().nonnegative().catch(0);

export const NoteDocSchema = z.looseObject({
  _id: z.string().startsWith('note:'),
  _rev: z.string(),
  title: z.string().catch(''),
  body: z.string().catch(''),
  bookId: z.string(),
  tags: z.array(z.string()).catch([]),
  status: z.enum(NOTE_STATUSES).catch('none'),
  pinned: z.boolean().catch(false),
  createdAt: millis,
  updatedAt: millis,
});

export const BookDocSchema = z.looseObject({
  _id: z.string().startsWith('book:'),
  _rev: z.string(),
  name: z.string(),
  parentBookId: z.string().nullish(),
  createdAt: millis,
});

export const TagDocSchema = z.looseObject({
  _id: z.string().startsWith('tag:'),
  _rev: z.string(),
  name: z.string(),
});

export const FileDocSchema = z.looseObject({
  _id: z.string().startsWith('file:'),
  _rev: z.string(),
  name: z.string().catch('file'),
  contentType: z.string().catch('application/octet-stream'),
  contentLength: z.number().catch(0),
  md5digest: z.string().nullish(),
  createdAt: millis,
  _attachments: z
    .record(
      z.string(),
      z.looseObject({ digest: z.string().optional(), data: z.string().optional() }),
    )
    .optional(),
});

export const ChangesSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      deleted: z.boolean().optional(),
      changes: z.array(z.object({ rev: z.string() })).catch([]),
      doc: z.unknown().optional(),
    }),
  ),
  last_seq: z.union([z.string(), z.number()]).transform(String),
});

export const RootSchema = z.object({ version: z.string(), ok: z.boolean().optional() });

export type NoteDoc = z.infer<typeof NoteDocSchema>;
export type BookDoc = z.infer<typeof BookDocSchema>;
export type TagDoc = z.infer<typeof TagDocSchema>;
export type FileDoc = z.infer<typeof FileDocSchema>;
