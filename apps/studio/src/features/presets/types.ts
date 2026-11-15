export type ContextStrategy='rolling_summary'|'sliding_window';
export type PresetRole='system'|'user'|'assistant';
export type PresetCustomNode={id:string;name:string;role:PresetRole;content:string;enabled:boolean};
export type StudioPreset={id:string;name:string;description:string;contextStrategy:ContextStrategy;maxContextTokens:number;maxOutputTokens:number;temperature:number;summaryPrompt:string;style:{content:string;enabled:boolean};customNodes:PresetCustomNode[];raw:Record<string,any>};
