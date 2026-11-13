export const EXTENSION_OPEN = '<sr_extensions>';
export const MAX_TAIL_BYTES = 262_144;

/** Bounded marker look-behind. Once a tail starts, text can never become visible again. */
export class ExtensionStreamSplitter {
  private prefix = '';
  private highSurrogate = '';
  private raw = '';
  private bytes = 0;
  hidden = false;
  overflow = false;
  incompletePrefix = false;

  push(delta: string): string {
    let chunk = this.highSurrogate + delta;
    this.highSurrogate = '';
    const last = chunk.charCodeAt(chunk.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) { this.highSurrogate = chunk.slice(-1); chunk = chunk.slice(0, -1); }
    return this.consume(chunk);
  }
  private consume(chunk: string): string {
    if (this.hidden) { this.capture(chunk); return ''; }
    const text = this.prefix + chunk;
    this.prefix = '';
    const index = text.indexOf(EXTENSION_OPEN);
    if (index >= 0) {
      this.hidden = true;
      this.capture(text.slice(index));
      return text.slice(0, index);
    }
    let keep = Math.min(text.length, EXTENSION_OPEN.length - 1);
    while (keep > 0 && !EXTENSION_OPEN.startsWith(text.slice(-keep))) keep--;
    this.prefix = keep ? text.slice(-keep) : '';
    return keep ? text.slice(0, -keep) : text;
  }
  private capture(text: string): void {
    if (this.overflow) return;
    this.bytes += Buffer.byteLength(text, 'utf8');
    if (this.bytes > MAX_TAIL_BYTES) { this.overflow = true; this.raw = ''; return; }
    this.raw += text;
  }
  finish(): string {
    const visible = this.highSurrogate ? this.consume('\uFFFD') : '';
    this.highSurrogate = '';
    this.incompletePrefix = !this.hidden && this.prefix.length > 0;
    return visible;
  }
  get tail(): string | undefined { return this.hidden && !this.overflow ? this.raw : undefined; }
}
