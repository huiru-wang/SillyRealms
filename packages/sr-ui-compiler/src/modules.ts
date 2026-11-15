import {parse} from '@babel/parser';
export type ComponentSource={id:string;component:string};
export const externalModules=new Set(['react','react-dom/client','react/jsx-runtime','@sillyrealms/sdk']);

export function inspectModule(source:string, ids:ReadonlySet<string>=new Set()):string[] {
  const ast=parse(source,{sourceType:'module',plugins:['typescript','jsx']});
  const dependencies:string[]=[];
  let hasDefault=false;
  for(const node of ast.program.body){
    if(node.type==='ExportDefaultDeclaration')hasDefault=true;
    if(node.type==='ExportAllDeclaration'||node.type==='ExportNamedDeclaration'&&node.source)throw Error('不支持转发导出');
    if(node.type==='ImportDeclaration'){
      const name=node.source.value;
      if(externalModules.has(name))continue;
      if(!name.startsWith('./')||!ids.has(name.slice(2)))throw Error('不支持的依赖：'+name);
      if(node.specifiers.length!==1||node.specifiers[0]?.type!=='ImportDefaultSpecifier')throw Error('内部组件只支持默认导入：'+name);
      dependencies.push(name.slice(2));
    }
  }
  if(!hasDefault)throw Error('组件必须默认导出');
  const walk=(value:unknown):void=>{
    if(!value||typeof value!=='object')return;
    const node=value as Record<string,unknown>;
    const callee=node.callee as {type?:string;name?:string}|undefined;
    if(node.type==='ImportExpression'||node.type==='CallExpression'&&callee?.type==='Import')throw Error('不支持动态 import');
    if(node.type==='CallExpression'&&callee?.type==='Identifier'&&callee.name==='require')throw Error('不支持 require');
    for(const child of Object.values(node)){if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child);}
  };
  walk(ast.program);
  return dependencies;
}

export function moduleGraph(sources:ComponentSource[]) {
  const ids=new Set(sources.map(item=>item.id));
  if(ids.size!==sources.length)throw Error('组件 ID 重复');
  const graph=new Map(sources.map(item=>[item.id,inspectModule(item.component,ids)]));
  const complete=new Set<string>(),active=new Set<string>();
  function visit(id:string){
    if(active.has(id))throw Error('组件循环依赖：'+id);
    if(complete.has(id))return;
    active.add(id);for(const dependency of graph.get(id)??[])visit(dependency);
    active.delete(id);complete.add(id);
  }
  for(const id of ids)visit(id);
  return graph;
}
