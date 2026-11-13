import { publicRunResult } from './run-result.js';
import { ErrorCodes } from '../../common/error-codes.js';
import type { DatabaseSync } from 'node:sqlite';
import { readRunPage } from './history-page.js';

type Message = { id:string; role:'user'|'assistant'; text:string };
type Run = { id:string; status:string; messages:Message[] } & Record<string, any>;

/** Read one current ancestry page without splitting runs. Cursor is scoped to the session. */
export function historyRuns(db:DatabaseSync, sessionId:string, tip:string, limit:number, cursor?:string): {runs:Run[];nextCursor:string|null;hasMore:boolean} {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error(ErrorCodes.INVALID_CURSOR);
  const { groups, hasMore, nextCursor } = readRunPage(db, sessionId, tip, limit, cursor);
  const runs=groups.map(({id,rows}):Run=>{
    let status='completed';
    let result:Record<string, any>={};
    const messages:Message[]=[];
    for(const row of rows) {
      const ext=JSON.parse(String(row.ext_data));
      if(ext.run?.status) { result=publicRunResult(ext.run); status=String(result.status); }
      if(row.type!=='message' || (row.role!=='user' && row.role!=='assistant') || ext.nonNarrative) continue;
      const message=JSON.parse(String(row.payload)).message;
      const text=typeof message.content==='string' ? message.content : (message.content??[]).filter((part:{type:string})=>part.type==='text').map((part:{text:string})=>part.text).join('');
      if(text) messages.push({id:String(row.id),role:row.role,text});
    }
    return { ...result,id,status,messages };
  });
  return { runs, hasMore, nextCursor };
}
