import type { AssistantMessageEvent, Message } from '@earendil-works/pi-ai';
import { parseRoleplay } from '@sillyrealms/roleplay';
import { ErrorCodes } from '../../common/error-codes.js';
import { RuntimeError } from '../shared/errors.js';
import type { PreparedRequest } from './budget.js';
import { SR_RP_SUMMARY_GUIDANCE } from './system-main.js';

export type HistoryItem = { id: string; role: 'user' | 'assistant'; text: string; gap?: string };
type Request = { previous: string | null; chunks: HistoryItem[] };
type Result = { history: HistoryItem[]; summary?: { text: string; coveredThroughEntryId: string; generation: Array<{ request: Request; response: string }> } };

export async function compressHistory(input: {
  oldSummary?: { text: string; coveredThroughEntryId: string }; history: HistoryItem[];
  shouldCompact: boolean; keepRecentTurns?: number; summarize: (request: Request) => Promise<string>;
}): Promise<Result> {
  const { history, oldSummary } = input;
  const logical = () => [...(oldSummary ? [{ id: 'summary', role: 'assistant' as const, text: oldSummary.text }] : []), ...history];
  if (!input.shouldCompact) return { history: logical() };
  const keep = input.keepRecentTurns ?? 5;
  if (!Number.isInteger(keep) || keep < 1) throw new RuntimeError(ErrorCodes.INVALID_PRESET_BUDGET);
  const turns = history.flatMap((item, index) => item.role === 'user' ? [index] : []);
  if (turns.length <= keep) return { history: logical() };
  const chunks = history.slice(0, turns[turns.length - keep]!);
  if (!chunks.length) return { history: logical() };
  const request = { previous: oldSummary?.text ?? null, chunks };
  const text = await input.summarize(request);
  if (!text.trim()) throw new RuntimeError(ErrorCodes.SUMMARY_EMPTY);
  return { history: [{ id: 'summary', role: 'assistant', text }, ...history.slice(chunks.length)],
    summary: { text, coveredThroughEntryId: chunks[chunks.length - 1]!.id, generation: [{ request, response: text }] } };
}
/** Retain offsets while excluding player direction from summary facts. */
export function summaryNarrative(text: string, role: 'user' | 'assistant'): string {
  const ranges = parseRoleplay(text, role).ranges.filter(range => range.kind === 'instruction');
  return ranges.reduceRight((value, range) => value.slice(0, range.start) +
    value.slice(range.start, range.end).replace(/[^\r\n]/gu, ' ') + value.slice(range.end), text);
}
/** No recursion or database access. Every complete summary request has its own measured budget. */
export async function summarizeInBudget(request: Request, options: {
  prompt: string; gaps: string[]; signal: AbortSignal;
  prepare: (messages: Message[]) => Promise<PreparedRequest>;
  generate: (request: PreparedRequest) => Promise<AsyncIterable<AssistantMessageEvent>>;
}): Promise<string> {
  let previous = request.previous;
  const pieces = request.chunks.map(item => ({ item, chars: Array.from(summaryNarrative(item.text, item.role)), offset: 0 }));
  let index = 0;
  while (index < pieces.length) {
    if (options.signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
    const batch: Array<{ sourceEntryId: string; start: number; end: number; role: string; text: string; gap?: string }> = [];
    const messages = (values: typeof batch): Message[] => [
      { role: 'system', content: [SR_RP_SUMMARY_GUIDANCE, options.prompt,
        '仅概括已提供正文；stopped/failed/partial 或状态关闭表示未完成或未同步，不补造成功，不宣称缺口已修复。保留未解决的同步缺口。'].join('\n\n'), timestamp: 0 },
      { role: 'user', content: JSON.stringify({ previous, gaps: options.gaps, messages: values }), timestamp: 0 },
    ];
    while (index < pieces.length) {
      const source = pieces[index]!;
      if (!source.chars.length) { index++; continue; }
      let low = source.offset + 1, high = Math.min(source.chars.length, source.offset + 12000), fit = source.offset;
      while (low <= high) {
        const end = Math.floor((low + high) / 2);
        const candidate = { sourceEntryId: source.item.id, start: source.offset, end, role: source.item.role,
          text: source.chars.slice(source.offset, end).join(''), ...(source.item.gap ? { gap: source.item.gap } : {}) };
        const all = [...batch, candidate];
        const prepared = await options.prepare(messages(all));
        if (Array.from(JSON.stringify(all)).length <= 12000 && prepared.report.fits) { fit = end; low = end + 1; }
        else high = end - 1;
      }
      if (fit === source.offset) break;
      batch.push({ sourceEntryId: source.item.id, start: source.offset, end: fit, role: source.item.role,
        text: source.chars.slice(source.offset, fit).join(''), ...(source.item.gap ? { gap: source.item.gap } : {}) });
      source.offset = fit;
      if (source.offset === source.chars.length) index++; else break;
    }
    if (!batch.length) throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
    const prepared = await options.prepare(messages(batch));
    if (!prepared.report.fits) throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
    let text = '', normal = false, hadDelta = false, finished = false;
    for await (const event of await options.generate(prepared)) {
      if (options.signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      if (event.type === 'text_delta') { if (finished) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED); hadDelta = true; text += event.delta; }
      else if (event.type === 'done') {
        if (finished) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
        finished = true;
        normal = event.reason === 'stop' && event.message.stopReason === 'stop' &&
          !event.message.content.some(part => part.type === 'toolCall');
        const finalText = event.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
        if (!hadDelta) text = finalText;
        else if (text !== finalText) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
      } else if (event.type === 'error') throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
    }
    if (!normal || !text.trim()) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
    previous = text;
  }
  if (!previous?.trim()) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
  return previous;
}
