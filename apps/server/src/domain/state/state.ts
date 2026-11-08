import { ErrorCodes } from '../../common/error-codes.js';
import { initialAtomicState, validateAtomicSnapshot, validateAtomicValue, type AtomicStateDefinition } from './atomic-state.js';

export type Json = null | boolean | number | string | Json[] | { [key:string]:Json };
type Scope = 'global'|'session'|'message';
type State = { schema_version:1; scopes:Partial<Record<Scope,Record<string,AtomicStateDefinition>>> };
const unsafe = new Set(['__proto__','prototype','constructor']);
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null && typeof value==='object' && !Array.isArray(value);

/** Initialize one scope from its directly declared fields. */
export function initialState(state:unknown, scope:Scope):Record<string,Json> {
  if(state==null)return {};
  if(!isObject(state) || state.schema_version!==1 || !isObject(state.scopes))throw new Error(ErrorCodes.INVALID_STATE);
  const definitions=(state as State).scopes[scope] ?? {};
  return initialAtomicState(definitions);
}

/** Each opening override replaces its complete named state item, including JSON. */
export function applyOpening(state:unknown, initial:Record<string,Json>, override:unknown):Record<string,Json> {
  if(override==null)return initial;
  if(!isObject(override))throw new Error('opening.initial_state: expected object');
  const definitions=(state as State | null)?.scopes?.message ?? {};
  const result=structuredClone(initial);
  for(const [name,value] of Object.entries(override)) {
    const definition=definitions[name];
    if(!definition || !Object.hasOwn(result,name) || unsafe.has(name))throw new Error(`opening.initial_state.${name}: unknown state`);
    validateAtomicValue(definition,value);
    result[name]=structuredClone(value);
  }
  return result;
}

export function validateSnapshot(state:unknown,scope:Scope,value:unknown):asserts value is Record<string,Json> {
  if(state==null) { try { validateAtomicSnapshot({},value); } catch(error) { throw new Error(scope+': '+(error instanceof Error ? error.message : 'invalid state')); } return; }
  const definitions=(state as State).scopes?.[scope] ?? {};
  try { validateAtomicSnapshot(definitions,value); } catch(error) { throw new Error(scope+': '+(error instanceof Error ? error.message : 'invalid state')); }
}

export function decodeMessageState(text:string):Record<string,Json> {
  const entries:unknown=JSON.parse(text);
  if(!Array.isArray(entries))throw new Error('message: expected state array');
  const result:Record<string,Json>=Object.create(null);
  for(const entry of entries) {
    if(!isObject(entry) || typeof entry.key!=='string' || !entry.key || unsafe.has(entry.key) || Object.hasOwn(result,entry.key) || !Object.hasOwn(entry,'value'))throw new Error('message: invalid or duplicate state entry');
    result[entry.key]=entry.value as Json;
  }
  return result;
}
