/** SR-RP v1: a browser- and server-compatible text protocol. Offsets are UTF-16. */
export type RoleplayKind = 'action' | 'thought' | 'speech' | 'instruction';
export type RoleplayBlock = { id: string; kind: RoleplayKind; text: string };
export type RoleplayRange = { kind: RoleplayKind; start: number; end: number };
export type RoleplayComposerProjection = { blocks: RoleplayBlock[] };
export type ParsedRoleplay = {
  blocks: RoleplayBlock[];
  composerBlocks: RoleplayBlock[];
  narrativeText: string;
  instructionText: string[];
  ranges: RoleplayRange[];
  warnings: string[];
};

type Line = { start: number; end: number; content: string; fenced: boolean };
const OPEN = '<sr_instruction>';
const CLOSE = '</sr_instruction>';

/** Marks fenced code before looking for standalone protocol tags or Markdown quotes. */
function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let fence: { char: string; length: number } | undefined;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    const content = text.slice(start, newline < 0 ? end : newline).replace(/\r$/, '');
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    let fenced = !!fence;
    if (match) {
      const marker = match[1]!;
      if (!fence) { fence = { char: marker[0]!, length: marker.length }; fenced = true; }
      else if (marker[0] === fence.char && marker.length >= fence.length && !match[2]!.trim()) fence = undefined;
    }
    lines.push({ start, end, content, fenced });
    start = end;
  }
  return lines;
}

function unescapeText(text: string): string {
  return text.replace(/\\([\\“”<>`~])/g, '$1');
}
function escapeText(text: string): string {
  const mask = codeAndHtmlMask(text, linesOf(text));
  let output = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const lineStart = i === 0 || text[i - 1] === '\n';
    if (lineStart && c === '\n' && !mask[i]) output += '\\';
    const reservedTag = lineStart && (text.slice(i, i + OPEN.length) === OPEN || text.slice(i, i + CLOSE.length) === CLOSE);
    const tagLength = text.startsWith(OPEN, i) ? OPEN.length : CLOSE.length;
    const wholeTag = reservedTag && (i + tagLength === text.length || text[i + tagLength] === '\n');
    if (!mask[i] && (c === '\\' || c === '“' || c === '”' || lineStart && c === '>' || wholeTag)) output += '\\';
    output += c;
  }
  if (text.endsWith('\n') && !mask[text.length - 1]) output += '\\';
  return output;
}
function escapeInstruction(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/^(<\/?sr_instruction>)$/gm, '\\$1').replace(/^( {0,3})(`{3,}|~{3,})/gm, '$1\\$2');
}

/** Joins punctuation-only action fragments to the immediately preceding speech block. */
const TRAILING_SPEECH_PUNCTUATION = /^[，。！？；：、,.!?;:…—）】》)\]}]+$/u;

export function normalizeComposerBlocks(blocks: RoleplayBlock[]): RoleplayBlock[] {
  const normalized: RoleplayBlock[] = [];
  for (const block of blocks) {
    const previous = normalized[normalized.length - 1];
    const punctuation = block.text.trim();
    if (block.kind === 'action' && previous?.kind === 'speech' && punctuation && TRAILING_SPEECH_PUNCTUATION.test(punctuation)) previous.text += block.text;
    else normalized.push({...block});
  }
  return normalized;
}

/** Removes only trailing empty lines; blank blocks in the middle remain untouched. */
export function trimTrailingEmptyRoleplayLines(text: string): string {
  if (!text.trim()) return '';
  return text.replace(/(?:\r?\n[ \t]*)+$/u, '');
}

/** Empty action blocks are retained so intentional blank lines in the middle round-trip. */
export function serializeRoleplay(blocks: RoleplayBlock[]): string {
  const serialized: string[] = [];
  for (const block of blocks) {
    if (block.kind !== 'action' && !block.text.trim()) continue;
    if (block.kind === 'instruction') serialized.push(`${OPEN}\n${escapeInstruction(block.text)}\n${CLOSE}`);
    else if (block.kind === 'thought') serialized.push(block.text.split('\n').map(line => `> ${line.replace(/\\/g, '\\\\')}`).join('\n'));
    else if (block.kind === 'speech') serialized.push(`“${block.text.replace(/\\/g, '\\\\').replace(/[“”]/g, '\\$&').replace(/(?<=\n)(?=\n)/g, '\\')}”`);
    else serialized.push(escapeText(block.text));
  }
  return serialized.join('\n\n');
}

function codeAndHtmlMask(text: string, lines: Line[]): Uint8Array {
  const mask = new Uint8Array(text.length);
  for (const line of lines) if (line.fenced) mask.fill(1, line.start, line.end);
  const stack: Array<{tag:string; start:number}> = [];
  const openByTag = new Map<string, number[]>();
  let instructionDepth = 0, noCommentClose = false;
  const standalone = (at: number, token: string) => (at === 0 || text[at-1] === '\n') && text.startsWith(token, at) && (at+token.length === text.length || text[at+token.length] === '\n' || text.slice(at+token.length, at+token.length+2) === '\r\n');
  const tagStart = /<\/?([A-Za-z][\w:-]*)\b/y;
  const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) continue;
    if (!stack.length && (instructionDepth > 0 || standalone(i, OPEN))) {
      if (standalone(i, OPEN)) { instructionDepth++; i += OPEN.length - 1; continue; }
      if (standalone(i, CLOSE)) { instructionDepth--; i += CLOSE.length - 1; continue; }
      if (instructionDepth > 0) continue;
    }
    if (!stack.length && text[i] === '`' && (i === 0 || text[i - 1] !== '\\')) {
      let end = i; while (text[end] === '`') end++;
      const marker = text.slice(i, end), close = text.indexOf(marker, end);
      if (close >= 0 && !text.slice(end, close).includes('\n\n')) { mask.fill(1, i, close + marker.length); i = close + marker.length - 1; continue; }
    }
    if (text[i] === '<' && (i === 0 || text[i - 1] !== '\\') && !text.startsWith(OPEN, i) && !text.startsWith(CLOSE, i)) {
      if (text.startsWith('<!--', i)) {
        const close = noCommentClose ? -1 : text.indexOf('-->', i + 4);
        if (close < 0) noCommentClose = true;
        const end = close < 0 ? i + 4 : close + 3;
        mask.fill(1, i, end); i = end - 1; continue;
      }
      tagStart.lastIndex = i;
      const match = tagStart.exec(text);
      if (match) {
        let quote = '', end = i + match[0].length, malformed = false;
        for (; end < text.length; end++) {
          const char = text[end]!;
          if (quote) { if (char === quote) quote = ''; }
          else if (char === '"' || char === "'") quote = char;
          else if (char === '>') break;
          else if (char === '<' || (char === '\n' && text[end + 1] === '\n')) { malformed = true; break; }
        }
        if (malformed) { i = end - 1; continue; }
        if (end < text.length) {
          const tag = match[1]!.toLowerCase(), closing = text[i+1] === '/', selfClosing = /\/\s*>$/.test(text.slice(i,end+1)) || voidTags.has(tag);
          mask.fill(1, i, end + 1);
          if (closing) {
            const positions = openByTag.get(tag);
            const index = positions?.[positions.length - 1];
            if (index !== undefined) {
              mask.fill(1, stack[index]!.start, end + 1);
              while (stack.length > index) { const removed = stack.pop()!; const list = openByTag.get(removed.tag)!; list.pop(); if (!list.length) openByTag.delete(removed.tag); }
            }
          } else if (!selfClosing) {
            const positions = openByTag.get(tag) ?? []; positions.push(stack.length); openByTag.set(tag, positions);
            stack.push({tag, start:i});
          }
          i = end; continue;
        }
        // No closing delimiter exists for this candidate: retrying every '<'
        // would rescan the same suffix quadratically.
        break;
      }
    }
  }
  return mask;
}

function unescapeOutsideProtected(text: string, start: number, mask: Uint8Array): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && !mask[start+i] && (i === 0 || text[i-1] === '\n') && (i+1 === text.length || text[i+1] === '\n')) continue;
    if (text[i] === '\\' && !mask[start+i] && i+1 < text.length && /[\\“”<>]/.test(text[i+1]!)) result += text[++i];
    else result += text[i];
  }
  return result;
}

export function parseRoleplay(text: string, role: 'user' | 'assistant'): ParsedRoleplay {
  const lines = linesOf(text), mask = codeAndHtmlMask(text, lines);
  const instructionRanges: RoleplayRange[] = [], instructionText: string[] = [], warnings: string[] = [];
  if (role === 'user') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.fenced || mask[line.start] || line.content !== OPEN) continue;
      let depth = 1, nested = false, endIndex = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.fenced) continue;
        if (next.content === OPEN) { depth++; nested = true; }
        else if (next.content === CLOSE && --depth === 0) { endIndex = j; break; }
      }
      if (endIndex < 0) { warnings.push('unclosed_instruction'); break; }
      if (nested) { warnings.push('nested_instruction'); i = endIndex; continue; }
      const closing = lines[endIndex]!;
      const end = closing.start + CLOSE.length;
      const bodyEnd = closing.start > line.end && text[closing.start - 1] === '\n' ? closing.start - 1 : closing.start;
      let body = text.slice(line.end, bodyEnd); if (body.endsWith('\r')) body = body.slice(0, -1);
      instructionRanges.push({kind: 'instruction', start: line.start, end});
      instructionText.push(unescapeText(body));
      mask.fill(1, line.start, end);
      i = endIndex;
    }
  }
  const narrativeText = instructionRanges.reduceRight((result, range) => result.slice(0, range.start) + result.slice(range.end), text);
  const ranges: RoleplayRange[] = [...instructionRanges];
  // Paragraphs are editor blocks; source coordinates remain in original text.
  const segments: Array<{kind: RoleplayKind; start: number; end: number; text: string}> = [];
  let cursor = 0;
  for (let index = 0; index < instructionRanges.length; index++) {
    const range = instructionRanges[index]!;
    const raw = text.slice(cursor, range.start);
    let start = cursor, end = range.start;
    const startsWithBoundary = index > 0 && raw.startsWith('\n\n');
    const endsWithBoundary = raw.endsWith('\n\n');
    if (index > 0 && endsWithBoundary && raw === '\n\n') {
      // One separator between adjacent instruction blocks; no action block between them.
    } else {
      if (startsWithBoundary) start += 2;
      if (endsWithBoundary) end -= 2;
      if (start < end) segments.push({kind:'action', start, end, text:text.slice(start,end)});
      else if (raw.length >= 4 && startsWithBoundary && endsWithBoundary) segments.push({kind:'action', start, end:start, text:''});
      else if (index === 0 && raw === '\n\n') segments.push({kind:'action', start, end:start, text:''});
    }
    segments.push({kind:'instruction', start:range.start, end:range.end, text:instructionText[index]!});
    cursor = range.end;
  }
  if (cursor < text.length) {
    const raw = text.slice(cursor);
    let start = cursor;
    if (instructionRanges.length && raw === '\n\n') segments.push({kind:'action', start, end:start, text:''});
    else {
      if (instructionRanges.length && raw.startsWith('\n\n')) start += 2;
      if (start < text.length) segments.push({kind:'action', start, end:text.length, text:text.slice(start)});
    }
  }
  if (!instructionRanges.length && text.length === 0) segments.push({kind:'action', start:0, end:0, text:''});
  const blocks: RoleplayBlock[] = [];
  const composerBlocks: RoleplayBlock[] = [];
  const add = (kind: RoleplayKind, value: string) => {
    const block = {id:`rp-${blocks.length}-${composerBlocks.length}`, kind, text:value};
    if (value.trim()) blocks.push(block);
    if (kind === 'action' || value.trim()) composerBlocks.push({...block, id:`composer-${composerBlocks.length}`});
  };
  for (const segment of segments) {
    if (segment.kind === 'instruction') { add('instruction', segment.text); continue; }
    // Exactly two newlines separate blocks. Additional pairs represent intentional empty blocks.
    const paragraphs: Array<{raw: string; start: number}> = [];
    let part = 0;
    for (let i = 0; i < segment.text.length - 1; i++) {
      if (segment.text[i] === '\n' && segment.text[i+1] === '\n' && !mask[segment.start+i+1]) {
        paragraphs.push({raw:segment.text.slice(part,i), start:segment.start+part});
        part = i + 2;
        i++;
      }
    }
    paragraphs.push({raw:segment.text.slice(part), start:segment.start+part});
    for (const paragraph of paragraphs) {
      const {raw, start} = paragraph, end = start + raw.length;
      const sourceLines = raw.split('\n');
      if (raw && sourceLines.every(line => /^> ?/.test(line)) && !Array.from(mask.slice(start,end)).some(Boolean)) {
        const value = unescapeText(sourceLines.map(line => line.replace(/^> ?/, '')).join('\n'));
        add('thought', value);
        ranges.push({kind:'thought', start, end});
        continue;
      }
      if (raw && raw[0] === '“' && raw[raw.length - 1] === '”' && !mask[start] && !mask[end-1] && !/(^|[^\\\\])“/.test(raw.slice(1))) {
        const value = unescapeOutsideProtected(raw.slice(1, -1), start+1, mask);
        add('speech', value);
        ranges.push({kind:'speech', start, end});
      } else {
        add('action', unescapeOutsideProtected(raw, start, mask));
        // Inline dialogue remains part of the action block in the block Composer,
        // but its ranges are still exposed for message rendering/highlighting.
        for (let i = start; i < end; i++) {
          if (text[i] !== '“' || mask[i] || (i > start && text[i - 1] === '\\')) continue;
          let close = i + 1;
          while (close < end && (text[close] !== '”' || mask[close] || text[close - 1] === '\\')) close++;
          if (close === end) break;
          if (!Array.from(mask.slice(i, close + 1)).some(Boolean)) {
            ranges.push({kind:'speech', start:i, end:close+1});
            i = close;
          }
        }
      }
    }
  }
  ranges.sort((a,b) => a.start-b.start || a.end-b.end);
  return {blocks, composerBlocks, narrativeText, instructionText, ranges, warnings};
}

/** Projects the SR-RP v1 wire format into ordered block-level Composer nodes. */
export function parseRoleplayForComposer(text: string, role: 'user' | 'assistant'): RoleplayComposerProjection {
  return {blocks: parseRoleplay(text, role).composerBlocks};
}

export function narrativeForActivation(text: string, role: 'user' | 'assistant'): string {
  return parseRoleplay(text, role).narrativeText;
}
