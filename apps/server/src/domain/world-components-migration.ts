/** Data-only conversion: never compile or execute creator code during migration. */
export function migrateWorldComponents(data:Record<string,any>):Record<string,any> {
  const next=structuredClone(data);
  if(next.ui?.source!==undefined&&!Array.isArray(next.ui.source))throw Error('Legacy single-file UI requires explicit offline conversion');
  const components:Array<{id:string;component:string}>=next.components??next.ui?.source??[];
  if(!Array.isArray(components))throw Error('Expected component array');
  const ids=new Set(components.map(item=>item.id));
  const addDocument=(base:string,content:string)=>{
    let id=base;while(ids.has(id))id+='_';ids.add(id);
    components.push({id,component:`import React from 'react';\nimport { WorldDocumentContent } from '@sillyrealms/sdk';\nexport default function Document(){return <WorldDocumentContent content={${JSON.stringify(content)}}/>;}`});
    return {type:'component',component:id};
  };
  if(typeof next.description==='string')next.description=addDocument('WorldIntroduction',next.description);
  next.openings=(next.openings??[]).map((opening:Record<string,any>,index:number)=>opening.type?opening:{...opening,...addDocument('OpeningPreview'+(index+1),opening.content)});
  next.components=components;
  if(next.stage_component===undefined&&next.ui?.main)next.stage_component=next.ui.main;
  delete next.ui;
  return next;
}
