const NAMES = ['state_update', 'action_suggestions', 'character_sprite', 'sr_extensions'];
const MARKERS = NAMES.flatMap(name => ['<' + name, '</' + name]);
const MAX_PREFIX = Math.max(...MARKERS.map(marker => marker.length));

/** Prefix buffering is bounded; model output itself has no shared capability quota. */
export class NarrativeStreamSplitter {
  private prefix = '';
  private highSurrogate = '';
  private hiddenTail = '';
  private isHidden = false;
  private finished = false;

  get hidden(): boolean { return this.isHidden; }
  get tail(): string { return this.hiddenTail; }

  push(delta: string): string {
    if (this.finished) throw new Error('SPLITTER_FINISHED');
    let chunk = this.highSurrogate + delta;
    this.highSurrogate = '';
    const last = chunk.charCodeAt(chunk.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.highSurrogate = chunk.slice(-1);
      chunk = chunk.slice(0, -1);
    }
    return this.consume(chunk);
  }

  private consume(chunk: string): string {
    if (this.isHidden) { this.hiddenTail += chunk; return ''; }
    const text = this.prefix + chunk;
    this.prefix = '';
    const lower = text.replace(/[A-Z]/g, char => char.toLowerCase());
    let boundary = -1;
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== '<') continue;
      if (MARKERS.some(marker => lower.startsWith(marker, index) &&
        index + marker.length < text.length && /[^a-z0-9_]/i.test(text[index + marker.length]!))) {
        boundary = index;
        break;
      }
    }
    if (boundary >= 0) {
      this.isHidden = true;
      this.hiddenTail += text.slice(boundary);
      return text.slice(0, boundary);
    }
    let keep = Math.min(text.length, MAX_PREFIX);
    while (keep > 0 && !MARKERS.some(marker => marker.startsWith(lower.slice(-keep)))) keep--;
    this.prefix = keep ? text.slice(-keep) : '';
    return keep ? text.slice(0, -keep) : text;
  }

  /** Reserved incomplete prefixes never become public when generation stops. */
  finish(): string {
    if (this.finished) return '';
    const visible = this.highSurrogate ? this.consume('\uFFFD') : '';
    this.highSurrogate = '';
    if (this.prefix) {
      this.hiddenTail += this.prefix;
      this.prefix = '';
    }
    this.finished = true;
    return visible;
  }
}

/** Final provider snapshots are authoritative and must be separated independently of deltas. */
export function splitNarrativeContent(text: string): { content: string; tail: string } {
  const splitter = new NarrativeStreamSplitter();
  const content = splitter.push(text) + splitter.finish();
  return { content, tail: splitter.tail };
}
