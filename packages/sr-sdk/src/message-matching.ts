import type {MessageMatch,MessageRule} from './story-types.js';

/** Called inside the isolated worker; inputs are validated against the world card schema. */
export function matchMessage(text:string,role:'user'|'assistant',rules:MessageRule[],progress:(event:'start'|'end',invalid:boolean|undefined,index:number,matches:MessageMatch[])=>void=()=>{},initial:MessageMatch[]=[]):MessageMatch[]{
  const accepted:MessageMatch[]=[...initial];let outputSize=new TextEncoder().encode(JSON.stringify(accepted)).byteLength;
  for(const [index,rule] of rules.entries()){
    if(!rule.roles.includes(role))continue;
    progress('start',undefined,index,accepted);
    const pattern=new RegExp(rule.pattern,rule.flags??'g');let result:RegExpExecArray|null;
    const pending:MessageMatch[]=[];let invalid=false;
    while((result=pattern.exec(text))!==null){
      if(!result[0].length){invalid=true;break;}
      const start=result.index,end=start+result[0].length;
      const item={start,end,ruleId:rule.id,replacement:rule.replacement,match:result[0],groups:result.slice(1),namedGroups:result.groups??{}};
      outputSize+=new TextEncoder().encode(JSON.stringify(item)).byteLength;if(outputSize>1024*1024)throw Error('MESSAGE_OUTPUT_LIMIT');pending.push(item);
      if(accepted.length+pending.length>500){invalid=true;break;}
      if(!pattern.global)break;
    }
    if(!invalid)accepted.push(...pending);
    progress('end',invalid,index,accepted);
  }
  return accepted.sort((a,b)=>a.start-b.start);
}
