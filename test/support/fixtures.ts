import type { DocChange } from '../../src/source/types.ts';

/** 1x1 transparent PNG. */
export const PNG_BYTES = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);
export const PNG_MD5 = new Bun.CryptoHasher('md5').update(PNG_BYTES).digest('hex');

export const T0 = Date.UTC(2024, 0, 15, 8, 30, 0, 123);

type Doc = Record<string, unknown>;

export function noteDoc(id: string, over: Doc = {}): Doc {
  return {
    _id: `note:${id}`,
    _rev: '1-a',
    doctype: 'markdown',
    title: `Note ${id}`,
    body: `Body of ${id}`,
    bookId: 'book:main',
    tags: [],
    status: 'none',
    share: 'private',
    createdAt: T0,
    updatedAt: T0 + 1000,
    numOfTasks: 0,
    numOfCheckedTasks: 0,
    timestamp: T0,
    ...over,
  };
}

export function bookDoc(id: string, name: string, over: Doc = {}): Doc {
  return { _id: `book:${id}`, _rev: '1-b', name, createdAt: T0, updatedAt: T0, ...over };
}

export function tagDoc(id: string, name: string): Doc {
  return { _id: `tag:${id}`, _rev: '1-t', name, color: 'default', createdAt: T0, updatedAt: T0 };
}

export function fileDoc(id: string, over: Doc = {}): Doc {
  return {
    _id: `file:${id}`,
    _rev: '1-f',
    name: 'clipboard.png',
    contentType: 'image/png',
    contentLength: PNG_BYTES.length,
    md5digest: PNG_MD5,
    createdAt: T0,
    publicIn: [],
    ...over,
  };
}

export function change(doc: Doc, deleted = false): DocChange {
  const id = String(doc['_id']);
  return {
    id,
    type: id.slice(0, id.indexOf(':')) as DocChange['type'],
    rev: String(doc['_rev']),
    deleted,
    doc,
  };
}

/** A small library exercising nesting, links, images, trash, tags, pins and front matter. */
export function sampleDocs(): Doc[] {
  return [
    bookDoc('main', 'Main'),
    bookDoc('child', 'Child', { parentBookId: 'book:main', createdAt: T0 + 1 }),
    bookDoc('dup1', 'Idea', { createdAt: T0 + 2 }),
    bookDoc('dup2', 'idea', { createdAt: T0 + 3 }),
    bookDoc('trashy', 'Old Trash Can', { createdAt: T0 + 4 }),
    tagDoc('t1', 'zeta'),
    tagDoc('t2', 'alpha'),
    fileDoc('img1'),
    fileDoc('orphan'),
    noteDoc('a', {
      title: 'Alpha: intro',
      tags: ['tag:t1', 'tag:t2'],
      pinned: true,
      status: 'active',
      body: [
        '# Alpha',
        '',
        'See [Beta](inkdrop://note/b) and [the beta note](inkdrop://note:b).',
        '![w:320 h:240](inkdrop://file:img1)',
        '',
        '```md',
        '[code](inkdrop://note/b)',
        '```',
        '',
        '[missing](inkdrop://note/zzz)',
      ].join('\n'),
    }),
    noteDoc('b', { title: 'Beta', bookId: 'book:child', createdAt: T0 + 5 }),
    noteDoc('c', {
      title: 'Beta',
      bookId: 'book:dup2',
      createdAt: T0 + 6,
      body: '---\nslug: keep-me # comment\n---\nLinks to [Alpha/intro](inkdrop://note/a)',
    }),
    noteDoc('d', { title: 'Gone', bookId: 'trash', body: '![img](inkdrop://file:img1)' }),
    noteDoc('tpl', { title: 'Template', bookId: 'template' }),
  ];
}
