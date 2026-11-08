import { parse } from '@babel/parser';
import * as esbuild from 'esbuild-wasm';
import wasm from 'esbuild-wasm/esbuild.wasm?url';
let init:Promise<void>|undefined;
export async function compile(source:string){
 const ast=parse(source,{sourceType:'module',plugins:['typescript','jsx']});
 for(const node of ast.program.body){if(node.type==='ImportDeclaration'&&!['react','react-dom/client','react/jsx-runtime','@sr/sdk'].includes(node.source.value))throw Error('不支持的依赖：'+node.source.value);if(node.type==='ExportAllDeclaration'||node.type==='ExportNamedDeclaration'&&node.source)throw Error('不支持转发导出');}
 const walk=(value:unknown)=>{if(!value||typeof value!=='object')return;const node=value as Record<string,unknown>;if(node.type==='ImportExpression'||node.type==='CallExpression'&&(node.callee as {type?:string})?.type==='Import')throw Error('不支持动态 import');if(node.type==='CallExpression'&&(node.callee as {type?:string;name?:string})?.type==='Identifier'&&(node.callee as {name?:string}).name==='require')throw Error('不支持 require');for(const child of Object.values(node)){if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child);}};walk(ast.program);
 init??=esbuild.initialize({wasmURL:wasm,worker:true});await init;return (await esbuild.transform(source,{loader:'tsx',format:'cjs',jsx:'transform',target:'es2022'})).code;
}
