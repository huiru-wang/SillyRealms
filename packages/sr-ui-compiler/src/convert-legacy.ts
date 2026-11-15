import {parse} from '@babel/parser';
/** Offline conversion only. The runtime never resolves the retired SDK name. */
function renameSDK(source:string){
 const ast=parse(source,{sourceType:'module',plugins:['typescript','jsx']});
 const edits:Array<{start:number;end:number;text:string}>=[];
 for(const node of ast.program.body)if(node.type==='ImportDeclaration'&&node.source.value==='@sr/sdk')edits.push({start:node.source.start!,end:node.source.end!,text:"'@sillyrealms/sdk'"});
 for(const edit of edits.reverse())source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
 return source;
}
export function convertLegacyUI(ui:any,messageRender:any):{ui:any;messageRender:any;changed:boolean}{
 const before=JSON.stringify({ui,messageRender});
 ui=structuredClone(ui);messageRender=structuredClone(messageRender);
 let source:Array<{id:string;component:string}>=Array.isArray(ui?.source)?ui.source:[];
 const ids=new Set(source.map(item=>item.id));
 const fresh=(base:string)=>{let id=base;while(ids.has(id))id+='_';ids.add(id);return id;};
 if(typeof ui?.source==='string'){
  const main=fresh('Main');source=[{id:main,component:renameSDK(ui.source)}];ui={source,main};
 }
 if(typeof messageRender?.component_source==='string'){
  const text=renameSDK(messageRender.component_source);
  const ast=parse(text,{sourceType:'module',plugins:['typescript','jsx']});
  const exported=ast.program.body.find(node=>node.type==='ExportDefaultDeclaration');
  if(!exported||exported.type!=='ExportDefaultDeclaration')throw Error('旧消息组件缺少默认导出');
  const value=exported.declaration;
  if(value.type==='FunctionDeclaration'||value.type==='ClassDeclaration')throw Error('旧消息组件必须默认导出组件映射');
  let registry='LegacyMessageRegistry';while(text.includes(registry))registry+='_';
  const libraryId=fresh('MessageLibrary');
  const expression=text.slice(value.start!,value.end!);
  const replacement=`function ${registry}(){return null;}\n${registry}.components=(${expression});\nexport default ${registry};`;
  source.push({id:libraryId,component:text.slice(0,exported.start!)+replacement+text.slice(exported.end!)});
  // One shared module preserves the old library's closure and module-level state.
  const referenced=new Set<string>((messageRender.rules??[]).filter((rule:any)=>rule.replacement?.type==='component').map((rule:any)=>rule.replacement.component));
  const remap=new Map<string,string>();
  for(const id of referenced){
   const componentId=fresh(/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(id)?id:'Message');
   source.push({id:componentId,component:`import Library from './${libraryId}';\nexport default Library.components[${JSON.stringify(id)}];`});
   remap.set(id,componentId);
  }
  for(const rule of messageRender.rules??[])if(rule.replacement?.type==='component')rule.replacement.component=remap.get(rule.replacement.component)??rule.replacement.component;
  delete messageRender.component_source;
  ui={...(ui??{}),source};
 }
 if(ui?.source)ui.source=source.map(item=>({...item,component:renameSDK(item.component)}));
 return {ui,messageRender,changed:before!==JSON.stringify({ui,messageRender})};
}
