import type { AssistantMessageEvent, Message } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../../../common/error-codes.js';
import { RuntimeError } from '../../shared/errors.js';
import { SR_RP_SUMMARY_GUIDANCE } from '../system-main.js';
import { estimateContext } from './estimator.js';
import { summaryNarrative, type HistoryItem } from './history.js';

export async function generateSummary(input: {
  previous: string | null; history: HistoryItem[]; prompt: string; gaps: string[];
  limit: number; signal: AbortSignal;
  generate: (messages: Message[]) => Promise<AsyncIterable<AssistantMessageEvent>>;
}): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: [SR_RP_SUMMARY_GUIDANCE, input.prompt,
      '仅概括已提供正文；stopped/failed/partial 或状态关闭表示未完成或未同步，不补造成功，不宣称缺口已修复。保留未解决的同步缺口。'].join('\n\n'), timestamp: 0 },
    { role: 'user', content: JSON.stringify({ previous: input.previous, gaps: input.gaps,
      messages: input.history.map(item => ({ sourceEntryId: item.id, role: item.role, text: summaryNarrative(item.text, item.role), gap: item.gap })) }), timestamp: 0 },
  ];
  if (input.signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
  if (estimateContext({ messages }) > input.limit) throw new RuntimeError(ErrorCodes.SUMMARY_CAPACITY_EXCEEDED);
  let text = '', finalText = '', hadDelta = false, finished = false;
  try {
    for await (const event of await input.generate(messages)) {
      if (input.signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      if (event.type.startsWith('toolcall_')) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
      if (event.type === 'text_delta') {
        if (finished) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
        hadDelta = true; text += event.delta;
      } else if (event.type === 'done') {
        if (finished || event.reason !== 'stop' || event.message.stopReason !== 'stop' || event.message.content.some(p => p.type === 'toolCall'))
          throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
        finished = true;
        finalText = event.message.content.filter(p => p.type === 'text').map(p => p.text).join('');
      } else if (event.type === 'error') throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
    }
  } catch (error) {
    if (input.signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
    throw new RuntimeError(ErrorCodes.SUMMARY_FAILED, { causeCode: error instanceof RuntimeError ? error.code : ErrorCodes.PROVIDER_ERROR });
  }
  if (input.signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
  if (!finished || (hadDelta && text !== finalText)) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
  if (!finalText.trim()) throw new RuntimeError(ErrorCodes.SUMMARY_EMPTY);
  return finalText;
}
