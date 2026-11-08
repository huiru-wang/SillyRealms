import { ErrorCodes } from '../../common/error-codes.js';
import type { DatabaseSync } from 'node:sqlite';
import { readAncestors } from './ancestors.js';

type Message = { id:string; role:'user'|'assistant'; text:string };
type Run = { id:string; status:string; messages:Message[] };
type Entry = Record<string, unknown>;

/** Read one current ancestry page without splitting runs. Cursor is scoped to the session. */
export function historyRuns(db:DatabaseSync, sessionId:string, tip:string, limit:number, cursor?:string): {runs:Run[];nextCursor:string|null;hasMore:boolean} {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error(ErrorCodes.INVALID_CURSOR);
  const chain = readAncestors(db, sessionId, tip) as Entry[];
  const groups = new Map<string,{ start:number; rows:Entry[] }>();
  for (const row of chain) {
    const id=String(row.run_id);
    const group=groups.get(id) ?? { start:Number(row.seq), rows:[] };
    group.rows.push(row); groups.set(id,group);
  }
  let before=Number.MAX_SAFE_INTEGER;
  if (cursor) {
    try {
      const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')) as {sessionId?:unknown;before?:unknown};
      if (decoded.sessionId !== sessionId || !Number.isSafeInteger(decoded.before) || ![...groups.values()].some(group=>group.start===decoded.before)) throw new Error();
      before=decoded.before as number;
    } catch { throw new Error(ErrorCodes.INVALID_CURSOR); }
  }
  const candidates=[...groups.entries()].filter(([,group])=>group.start<before).sort((a,b)=>b[1].start-a[1].start);
  const page=candidates.slice(0,limit).reverse();
  const runs=page.map(([id,group]):Run=>{
    let status='completed';
    const messages:Message[]=[];
    for(const row of group.rows) {
      const ext=JSON.parse(String(row.ext_data));
      if(ext.run?.status) status=String(ext.run.status);
      if(row.type!=='message' || (row.role!=='user' && row.role!=='assistant') || ext.nonNarrative) continue;
      const message=JSON.parse(String(row.payload)).message;
      const text=typeof message.content==='string' ? message.content : (message.content??[]).filter((part:{type:string})=>part.type==='text').map((part:{text:string})=>part.text).join('');
      if(text) messages.push({id:String(row.id),role:row.role,text});
    }
    return { id,status,messages };
  });
  const hasMore=candidates.length>limit;
  const first=page[0];
  return { runs, hasMore, nextCursor:hasMore && first ? Buffer.from(JSON.stringify({sessionId,before:first[1].start})).toString('base64url') : null };
}
