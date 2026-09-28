export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

export function md5Hex(data: Uint8Array): string {
  return new Bun.CryptoHasher('md5').update(data).digest('hex');
}

/** CouchDB attachment digests look like `md5-<base64>`; returns lowercase hex or null. */
export function couchDigestToHex(digest: string): string | null {
  if (!digest.startsWith('md5-')) return null;
  const bytes = Buffer.from(digest.slice(4), 'base64');
  return bytes.length === 16 ? bytes.toString('hex') : null;
}
