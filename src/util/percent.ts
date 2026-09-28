/**
 * Percent-encodes a single path segment / URL component. Unlike `encodeURIComponent` it also
 * escapes `( ) ! ' *`, so the result is always safe inside a Markdown link destination.
 */
export function encodeComponent(s: string): string {
  return encodeURIComponent(s.normalize('NFC')).replace(
    /[()!'*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Decodes a component, returning the input unchanged when it is not valid percent-encoding. */
export function decodeComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
