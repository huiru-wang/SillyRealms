export type CapabilityExtraction = {
  status: 'missing' | 'empty' | 'present' | 'invalid_tag';
  blocks: string[];
};

/**
 * A capability knows only its own tags. Bad boundaries invalidate this capability,
 * never provide recovery anchors for another one and never expose a partial body.
 */
export function extractCapability(text: string, name: string): CapabilityExtraction {
  if (!/^[a-z][a-z0-9_]*$/i.test(name)) throw new Error('INVALID_CAPABILITY_NAME');
  const marker = new RegExp('<(/?)' + name + '(?=[^a-z0-9_]|$)', 'gi');
  const complete = new RegExp('<(/?)' + name + '\\s*>', 'iy');
  const blocks: string[] = [];
  let start: number | undefined, found = false;

  for (const match of text.matchAll(marker)) {
    found = true;
    complete.lastIndex = match.index;
    const tag = text.match(complete);
    if (!tag || Boolean(tag[1]) !== Boolean(match[1])) return { status: 'invalid_tag', blocks: [] };
    if (!tag[1]) {
      if (start !== undefined) return { status: 'invalid_tag', blocks: [] };
      start = complete.lastIndex;
    } else {
      if (start === undefined) return { status: 'invalid_tag', blocks: [] };
      blocks.push(text.slice(start, match.index));
      start = undefined;
    }
  }
  if (start !== undefined) return { status: 'invalid_tag', blocks: [] };
  if (!found) return { status: 'missing', blocks: [] };
  return { status: blocks.some(block => block.trim()) ? 'present' : 'empty', blocks };
}
