import type {StateSchema,StateDefinition} from '@sillyrealms/sdk/state-validation';
export type {StateDefinition} from '@sillyrealms/sdk/state-validation';
export type Tag={name:string;worldCount:number};
export type WorldPublication={
 package_id:string;authors:Array<{name:string;url?:string}>;creator_notes?:string;
 release:{version:string;published_at:string;notes:string};homepage?:string;update_url?:string;
};
export type WorldVersionSummary={
 currentVersion:string|null;latestVersion:string|null;
 updateStatus:'no_source'|'not_checked'|'checking'|'ready'|'failed';
};
export type WorldRelease={
 version:string;title?:string;published_at:string;notes:string;spec_version:string;supported:boolean;
 artifact:{format:'zip'|'json';url:string;sha256:string;size_bytes:number};
};
export type WorldVersionsView=WorldVersionSummary & {
 worldId:string;lastSuccessAt:number|null;lastAttemptAt:number|null;errorCode:string|null;versions:WorldRelease[];
};
export type WorldVersionApplication={version:string;expectedSha256:string;expectedRevision:number};
export type WorldListItem=WorldVersionSummary & {id:string;name:string;publication:WorldPublication|null;cover:string|null;coverMosaicEnabled:boolean;tags:string[];sessionCount:number;createdAt:number;updatedAt:number};
export type Character={id:string;name:string;description?:string;prompt?:string;avatar?:string;player_selectable?:boolean;order?:number;load?:StateDefinition['load']};
export type Opening={type?:'component';component?:string;id:string;name:string;content:string;initial_state?:Record<string,unknown>};
export type LoreEntry={id:string;title?:string;content:string;enabled?:boolean;load?:StateDefinition['load'] & {order?:number}};
export type WorldDetail=WorldVersionSummary & {id:string;revision:number;specVersion:string;publication:WorldPublication|null;name:string;cover:string|null;coverMosaicEnabled:boolean;tags:string[];
 description:string|{type:'component';component:string}|null;characters:Character[];openings:Opening[];
 lorebook:{entries:LoreEntry[]}|null;stateDefinition:StateSchema|null;
 components:Array<{id:string;path?:string;component?:string}>|null;stageComponent:string|null;messageRender:unknown;extensions:unknown;
 defaultPresetId:string|null;defaultReplyAssistPresetId:string|null;defaultApiModelConfigId:string|null;createdAt:number;updatedAt:number};
export type WorldPatch=Partial<Pick<WorldDetail,'name'|'tags'|'defaultPresetId'|'defaultReplyAssistPresetId'|'defaultApiModelConfigId'|'coverMosaicEnabled'>>;
export type Session={id:string;worldId:string;title:string|null;updatedAt:number;cover:string|null};
