import {i18n} from '../../i18n/instance.ts';
import type {CompiledComponents} from '../../../../../packages/sr-ui-compiler/src/index.js';
import type {MessageRule} from '../../../../../packages/sr-sdk/src/story-types.js';
import type {WorldDetail} from './api/worlds.js';
import {stateManifest,type StateManifest} from '../state/manifest.ts';
import {worldAssetBaseUrl} from './resources.ts';

type WorldRequest=<T>(path:string,options?:RequestInit)=>Promise<T>;
export type StageWorld={
  world:WorldDetail;modules:CompiledComponents;main:string|null;rules:MessageRule[];
  state:StateManifest;assetBaseUrl:string|null;
};
export type StageWorldDependencies={
  request?:WorldRequest;origin?:string;
  loadComponents?:(world:WorldDetail,signal?:AbortSignal)=>Promise<CompiledComponents>;
};
const requestWorld:WorldRequest=async<T>(path:string,options?:RequestInit)=>(await import('../../api')).api<T>(path,options);
async function loadComponents(world:WorldDetail,signal?:AbortSignal) {
  const [{compileWorldComponents},{compileComponents}]=await Promise.all([
    import('./compile-world-components'),import('../../../../../packages/sr-ui-compiler/src/index'),
  ]);
  signal?.throwIfAborted();
  return compileWorldComponents(world,compileComponents,signal);
}

/** Fetch the current V2 domain object and keep each component's compilation failure local. */
export async function loadStageWorld(worldId:string,signal?:AbortSignal,dependencies:StageWorldDependencies={}):Promise<StageWorld> {
  signal?.throwIfAborted();
  const response=await (dependencies.request??requestWorld)<{item:WorldDetail}>(
    'v1/worlds/'+encodeURIComponent(worldId),{signal});
  signal?.throwIfAborted();
  const world=response?.item;
  if(!world||world.id!==worldId||!Array.isArray(world.characters)||!Array.isArray(world.openings)||
    (world.components!==null&&!Array.isArray(world.components)))throw Error(i18n.t('worlds:invalidWorldResponse'));
  const modules=await (dependencies.loadComponents??loadComponents)(world,signal);
  signal?.throwIfAborted();
  const rendering=world.messageRender&&typeof world.messageRender==='object'?world.messageRender as {rules?:unknown}:null;
  const rules=Array.isArray(rendering?.rules)?structuredClone(rendering.rules) as MessageRule[]:[];
  return {
    world,modules,main:world.stageComponent??null,rules,state:stateManifest(world.stateDefinition),
    assetBaseUrl:worldAssetBaseUrl(dependencies.origin??globalThis.location?.origin,world.id),
  };
}
