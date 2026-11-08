/** Debug logs may include complete prompts, messages and state. */
export const debugEnabled = () => process.env.SILLYREALMS_DEBUG === '1';
export function debugLog(title:string, detail:unknown):void {
  if (!debugEnabled()) return;
  console.log(`\n┌─ ${title} ─ ${new Date().toISOString()}\n${JSON.stringify(detail,null,2)}\n└─ ${title} ─\n`);
}
