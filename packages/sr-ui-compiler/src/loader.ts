/** The evaluator is supplied only by the sandboxed iframe, never by the Host. */
export function createModuleLoader(
  code:Record<string,string>, errors:Record<string,string>, externals:Record<string,unknown>,
  evaluate:(source:string,module:{exports:any},require:(name:string)=>unknown)=>void,
) {
  const modules=new Map<string,unknown>(),active=new Set<string>(),failures=new Map<string,Error>();
  function load(id:string):any {
    if(modules.has(id))return modules.get(id);
    if(failures.has(id))throw failures.get(id);
    if(active.has(id))throw Error('组件循环依赖：'+id);
    if(Object.hasOwn(errors,id))throw Error(id+'：'+errors[id]);
    if(!Object.hasOwn(code,id))throw Error('组件不存在：'+id);
    active.add(id);
    try {
      const module={exports:{} as any};
      evaluate(code[id]!,module,name=>{
        if(Object.hasOwn(externals,name))return externals[name];
        if(name.startsWith('./'))return {default:load(name.slice(2)),__esModule:true};
        throw Error('禁止的依赖：'+name);
      });
      const value=module.exports.default;
      const exotic=value&&typeof value==='object'&&[Symbol.for('react.memo'),Symbol.for('react.forward_ref')].includes(value.$$typeof);
      if(typeof value!=='function'&&!exotic)throw Error('默认导出必须是 React 组件：'+id);
      modules.set(id,value);return value;
    }catch(error){const failure=error instanceof Error?error:Error('组件加载失败：'+id);failures.set(id,failure);throw failure;}
    finally {active.delete(id);}
  }
  return load;
}
