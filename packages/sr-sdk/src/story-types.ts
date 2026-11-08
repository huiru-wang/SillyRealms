import type React from 'react';

export type MessageComponentProps={match:string;groups:Array<string|undefined>;namedGroups:Record<string,string|undefined>;message:{id:string;role:'user'|'assistant'};runId:string};
export type MessageComponent=React.ComponentType<MessageComponentProps>&{srDisplay?:'inline'|'block'};
export type MessageRule={id:string;roles:Array<'user'|'assistant'>;pattern:string;flags?:string;replacement:{type:'component';component:string}|{type:'html'|'markdown';content:string}};
export type MessageMatch={start:number;end:number;ruleId:string;replacement:MessageRule['replacement'];match:string;groups:Array<string|undefined>;namedGroups:Record<string,string|undefined>};
export type StoryConfiguration={rules:MessageRule[];components:Record<string,MessageComponent>;state:Record<string,unknown>;ready:()=>void;match:(text:string,role:'user'|'assistant')=>Promise<{matches:MessageMatch[];warning:boolean}>};
