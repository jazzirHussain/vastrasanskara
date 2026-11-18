// Small HTTP helpers shared by modules.

/** `attachment; filename="…"`, with an RFC 5987 UTF-8 name beside an ASCII one when needed. */
export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const plain = `attachment; filename="${ascii}"`;
  return ascii === filename ? plain : `${plain}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
