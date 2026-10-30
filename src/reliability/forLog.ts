// Cap for any remote-supplied value that reaches the log. The socket accepts
// very large frames and every accessory listens on the same one, so an
// unbounded log of remote content is both a disk-fill risk and, via embedded
// newlines, a way to forge log lines.
const MAX_LOGGED_REMOTE_CHARS = 200;

export function forLog(value: unknown): string {
  const text = String(value).slice(0, MAX_LOGGED_REMOTE_CHARS);
  let sanitized = '';
  for (const character of text) {
    const code = character.charCodeAt(0);
    sanitized += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  return sanitized;
}
