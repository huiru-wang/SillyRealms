import { ErrorCodes } from '../../common/error-codes.js';
import type { Message } from '@earendil-works/pi-ai';
import { estimateTokens } from './prompt-builder.js';

export type HistoryItem = { id:string; role:'user'|'assistant'; text:string };
type Request = { previous:string | null; chunks:HistoryItem[] };
type Result = { history:HistoryItem[]; summary?:{ text:string; coveredThroughEntryId:string; generation:Array<{request:Request;response:string}> } };
const N = 40, K = 12;

/** Compress oldest complete narrative records; never silently discard source text. */
export async function compressHistory(input:{
  oldSummary?: { text:string; coveredThroughEntryId:string };
  history:HistoryItem[];
  budget:number;
  build:(history:HistoryItem[]) => Message[];
  toolJson:string;
  summarize:(request:Request) => Promise<string>;
}): Promise<Result> {
  const { oldSummary, budget, build, toolJson, summarize } = input;
  const original = [...input.history];
  let summary = oldSummary?.text ?? null;
  let covered = oldSummary?.coveredThroughEntryId;
  let consumed = 0;
  let shortenAttempts = 0;
  const generations:Array<{request:Request;response:string}> = [];
  const logical = () => [...(summary ? [{id:'summary',role:'assistant' as const,text:summary}] : []), ...original.slice(consumed)];
  if (original.length < N && estimateTokens(build(logical()),toolJson) <= budget) return { history:logical() };
  let desired = Math.max(0, original.length - K);
  if (!desired && original.length) desired = 1;
  while (estimateTokens(build(logical()),toolJson) > budget || consumed < desired) {
    if (consumed >= original.length) {
      if (!summary || shortenAttempts++ >= 3) throw new Error(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
      const request = { previous:null, chunks:[{id:'summary',role:'assistant' as const,text:summary}] };
      const response = await summarize(request);
      if (!response.trim()) throw new Error(ErrorCodes.SUMMARY_EMPTY);
      generations.push({request,response}); summary=response; continue;
    }
    const end = consumed < desired ? desired : consumed + 1;
    const chunks = original.slice(consumed,end);
    const request = { previous:summary, chunks };
    const response = await summarize(request);
    if (!response.trim()) throw new Error(ErrorCodes.SUMMARY_EMPTY);
    generations.push({request,response}); summary = response; covered = chunks[chunks.length-1]!.id; consumed = end;
  }
  if (!generations.length || !summary || !covered) throw new Error(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
  return { history:logical(), summary:{ text:summary, coveredThroughEntryId:covered, generation:generations } };
}
