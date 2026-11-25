export type SessionRuntimeConfig={
  narrativePresetId:string;apiModelConfigId:string;replyAssistPresetId:string|null;replyAssistGoal:string;fontSize:number;
};
export type SessionSummary={id:string;worldId:string;runtimeConfig:SessionRuntimeConfig;worldName:string;cover:string|null;title:string|null;updatedAt:number};
export type Session=SessionSummary & {userCharacterId:string;tipEntryId:string|null};
