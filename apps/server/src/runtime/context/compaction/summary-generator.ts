import type { AssistantMessageEvent, Message } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../../../common/error-codes.js';
import { RuntimeError } from '../../shared/errors.js';
import { assistantMessage } from '../contracts.js';
import { estimateContext } from './estimator.js';
import { summaryNarrative, type HistoryItem } from './history.js';

export async function generateSummary(input: {
  previous: string | null; history: HistoryItem[]; prompt: string;
  limit: number; signal: AbortSignal;
  generate: (messages: Message[]) => Promise<AsyncIterable<AssistantMessageEvent>>;
}): Promise<string> {
  const messages:Message[]=[{role:'system',content:input.prompt,timestamp:0},...(input.previous?[assistantMessage(input.previous)]:[]),...input.history.map(item=>item.role==='assistant'?assistantMessage(summaryNarrative(item.text,item.role)):{role:'user' as const,content:summaryNarrative(item.text,item.role),timestamp:0})];
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
