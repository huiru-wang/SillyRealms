import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentRuntime } from '../agent/index.js';
import { readAncestors } from '../domain/session/ancestors.js';
import { readWorld } from '../repositories/world-repository.js';
import { decodeMessageState, validateSnapshot } from '../domain/state/state.js';
import { updateAtomicState, type AtomicScope, type AtomicStateDefinition } from '../domain/state/atomic-state.js';
import { failure, ok } from '../common/http-response.js';
import { ErrorCodes, normalizeError, type PublicError } from '../common/error-codes.js';

const update = z.object({path:z.string().min(1), scope:z.enum(['global','session','message']).default('message'), value:z.unknown()}).strict().superRefine((value,ctx)=>{if(!Object.hasOwn(value,'value'))ctx.addIssue({code:'custom',path:['value'],message:'Value required'});});
const request = z.object({updates:z.array(update)}).strict();

/** Process each update separately, preserving order and emitting only committed changes. */
export function stateUpdateRoutes(db:DatabaseSync,runtime:AgentRuntime):Hono {
  const app=new Hono();
  app.patch('/:id/state',async c=>{
    const parsed=request.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json(failure(ErrorCodes.INVALID_REQUEST),400);
    const id=c.req.param('id');
    if(!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id))return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
    const results:Array<{path:string;scope:AtomicScope} & (
      {success:true;errorCode:null;errorMessage:''} |
      {success:false} & PublicError
    )>=[];
    for(const item of parsed.data.updates) {
      let change:{scope:AtomicScope;path:string;value:unknown;worldId:string}|undefined;
      try {
        const initial=db.prepare('SELECT world_id FROM sessions WHERE id=?').get(id);
        if(!initial)throw new Error(ErrorCodes.SESSION_NOT_FOUND);
        const worldId=String(initial.world_id);
        if(runtime.worldBusy(worldId))throw new Error(ErrorCodes.WORLD_BUSY);
        db.exec('BEGIN IMMEDIATE');
        try {
          const session=db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
          const world=db.prepare('SELECT * FROM worlds WHERE id=?').get(worldId);
          if(!session)throw new Error(ErrorCodes.SESSION_NOT_FOUND);
          if(!world)throw new Error(ErrorCodes.WORLD_NOT_FOUND);
          const definition=readWorld(world).data.state;
          const chain=readAncestors(db,id,String(session.tip_entry_id));
          const last=[...chain].reverse().find(entry=>entry.state!==null);
          const snapshot=item.scope==='global'?JSON.parse(String(world.state)):item.scope==='session'?JSON.parse(String(session.state)):decodeMessageState(String(last?.state??'[]'));
          const fields=(definition?.scopes?.[item.scope]??{}) as Record<string,AtomicStateDefinition>;
          const result=updateAtomicState(snapshot,fields,item.path,item.value);
          validateSnapshot(definition,item.scope,snapshot);
          if(result.changed) {
            if(item.scope==='global')db.prepare('UPDATE worlds SET state=?,updated_at=? WHERE id=?').run(JSON.stringify(snapshot),Date.now(),worldId);
            else if(item.scope==='session')db.prepare('UPDATE sessions SET state=?,updated_at=? WHERE id=?').run(JSON.stringify(snapshot),Date.now(),id);
            else db.prepare('UPDATE entries SET state=? WHERE id=?').run(JSON.stringify(Object.entries(snapshot).map(([key,value])=>({key,value}))),String(session.tip_entry_id));
            change={scope:item.scope,path:item.path,value:result.value,worldId};
          }
          db.exec('COMMIT');
        } catch(error) {db.exec('ROLLBACK');throw error;}
        results.push({path:item.path,scope:item.scope,success:true,errorCode:null,errorMessage:''});
      } catch(error) {
        results.push({path:item.path,scope:item.scope,success:false,...normalizeError(error, ErrorCodes.INVALID_STATE_UPDATE)});
      }
      if(change) {
        const targets=change.scope==='global'?db.prepare('SELECT id FROM sessions WHERE world_id=?').all(change.worldId).map(row=>String(row.id)):[id];
        for(const target of targets)runtime.emit(target,'state.changed',{path:change.path,scope:change.scope,value:change.value});
      }
    }
    return c.json(ok(results));
  });
  return app;
}
