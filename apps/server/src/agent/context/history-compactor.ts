import { ErrorCodes } from '../../common/error-codes.js';

export type HistoryItem = { id:string; role:'user'|'assistant'; text:string };
type Request = { previous:string | null; chunks:HistoryItem[] };
type Result = { history:HistoryItem[]; summary?:{ text:string; coveredThroughEntryId:string; generation:Array<{request:Request;response:string}> } };

/** Summarize complete turns before the five most recent user turns. */
export async function compressHistory(input:{
  oldSummary?: { text:string; coveredThroughEntryId:string };
  history:HistoryItem[];
  shouldCompact:boolean;
  summarize:(request:Request) => Promise<string>;
}): Promise<Result> {
  const { history, oldSummary, summarize } = input;
  const logical = () => [...(oldSummary ? [{id:'summary', role:'assistant' as const, text:oldSummary.text}] : []), ...history];
  if (!input.shouldCompact) return { history:logical() };
  const turns = history.flatMap((item, index) => item.role === 'user' ? [index] : []);
  if (turns.length <= 5) return { history:logical() };
  const boundary = turns[turns.length - 5]!;
  const chunks = history.slice(0, boundary);
  if (!chunks.length) return { history:logical() };
  const request = { previous:oldSummary?.text ?? null, chunks };
  const text = await summarize(request);
  if (!text.trim()) throw new Error(ErrorCodes.SUMMARY_EMPTY);
  return {
    history:[{id:'summary',role:'assistant',text}, ...history.slice(boundary)],
    summary:{text, coveredThroughEntryId:chunks[chunks.length - 1]!.id, generation:[{request,response:text}]},
  };
}
