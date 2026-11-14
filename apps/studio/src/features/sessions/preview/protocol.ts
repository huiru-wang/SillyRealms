export const MESSAGE_LIMIT = 2 * 1024 * 1024;
export const themeVariables = [
  '--sr-story-bg', '--sr-story-surface', '--sr-story-text', '--sr-story-muted',
  '--sr-story-line', '--sr-story-accent', '--sr-story-focus',
] as const;
export type ThemeVariable = typeof themeVariables[number];
export type PreviewAppearance = {
  theme:'light'|'dark';
  fontSize:number;
  colors:Record<ThemeVariable,string>;
};
export const requestMethods = ['session.history','session.send','state.read','state.write','message.match'] as const;
export type RequestMethod = typeof requestMethods[number];

export function isRecord(value:unknown):value is Record<string,unknown>{
  return typeof value==='object' && value!==null && !Array.isArray(value);
}

/** Enforce the same serialized UTF-8 ceiling on both sides of the channel. */
export function withinMessageLimit(value:unknown):boolean{
  try {
    const text=JSON.stringify(value);
    return typeof text==='string' && new TextEncoder().encode(text).byteLength<=MESSAGE_LIMIT;
  } catch { return false; }
}

export function isRequestId(value:unknown):value is number{
  return typeof value==='number' && Number.isSafeInteger(value) && value>0;
}
