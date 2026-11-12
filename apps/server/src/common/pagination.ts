import { ErrorCodes } from './error-codes.js';
type Row = Record<string,unknown>;
export function pageByUpdated<T extends Row>(rows:T[], kind:string, limitText?:string, cursor?:string, scope?:string) {
  const limit = limitText === undefined ? 20 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error(ErrorCodes.INVALID_CURSOR);
  let before:{updatedAt:number;id:string}|undefined;
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
      if (parsed.kind !== kind || parsed.scope !== scope || typeof parsed.id !== 'string' || !Number.isSafeInteger(parsed.updatedAt)) throw new Error();
      before=parsed;
    } catch { throw new Error(ErrorCodes.INVALID_CURSOR); }
  }
  const eligible = before ? rows.filter(row => Number(row.updated_at) < before!.updatedAt || Number(row.updated_at) === before!.updatedAt && String(row.id) < before!.id) : rows;
  const items=eligible.slice(0,limit); const last=items[items.length-1];
  return {items,hasMore:eligible.length>limit,nextCursor:eligible.length>limit && last ? Buffer.from(JSON.stringify({kind,id:String(last.id),updatedAt:Number(last.updated_at),...(scope === undefined ? {} : {scope})})).toString('base64url') : null};
}
