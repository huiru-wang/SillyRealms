import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const roots=[new URL('../src/',import.meta.url).href,new URL('../../../packages/',import.meta.url).href];
const isSource=url=>roots.some(root=>url.startsWith(root));
const loader=registerHooks({
  resolve(specifier,context,nextResolve){
    if(context.parentURL&&isSource(context.parentURL)&&specifier.startsWith('.')){
      const path=new URL(specifier,context.parentURL);
      if(!existsSync(path)){
        const stem=specifier.endsWith('.js')?specifier.slice(0,-3):!extname(specifier)?specifier:null;
        if(stem)for(const extension of ['.ts','.tsx']){
          const candidate=new URL(stem+extension,context.parentURL);
          if(existsSync(candidate))return nextResolve(candidate.href,context);
        }
      }
    }
    return nextResolve(specifier,context);
  },
  load(url,context,nextLoad){
    if(isSource(url)&&url.endsWith('.css'))return {format:'module',source:'export default new Proxy({}, {get:(_,key)=>key});',shortCircuit:true};
    if(isSource(url)&&url.endsWith('.tsx')){
      const {outputText}=ts.transpileModule(readFileSync(new URL(url),'utf8'),{
        fileName:fileURLToPath(url),compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
      });
      return {format:'module',source:outputText,shortCircuit:true};
    }
    return nextLoad(url,context);
  },
});
after(()=>loader.deregister());
const {Modal}=await import('../src/components/ui/Modal.tsx');

// Capture the real portal returned by the component. SSR deliberately does not
// execute DOM effects; interaction ownership is exercised in its separate test.
function capture(props){
  let portal;
  function Inspect(){portal=Modal(props);return null;}
  renderToStaticMarkup(React.createElement(Inspect));
  return portal;
}

test('hidden retained modals keep the portal and children but remove modal semantics and interaction',t=>{
  const before=globalThis.document,container={nodeType:1};
  globalThis.document={body:container};
  t.after(()=>{if(before===undefined)delete globalThis.document;else globalThis.document=before;});
  const frame=React.createElement('iframe',{title:'Role preview'}),props={title:'Role',children:frame,onClose:()=>{}};
  const opened=capture(props),hidden=capture({...props,open:false});
  assert.equal(opened.containerInfo,container);assert.equal(hidden.containerInfo,container);
  assert.equal(opened.children.props.hidden,false);assert.equal(opened.children.props.inert,false);
  assert.equal(hidden.children.props.hidden,true);assert.equal(hidden.children.props.inert,true);
  assert.equal(hidden.children.props['aria-hidden'],true);
  const openPanel=opened.children.props.children,hiddenPanel=hidden.children.props.children;
  assert.equal(openPanel.props.role,'dialog');assert.equal(openPanel.props['aria-modal'],true);
  assert.equal(hiddenPanel.props.role,undefined);assert.equal(hiddenPanel.props['aria-modal'],undefined);
  assert.equal(hiddenPanel.props.children[1].props.children,frame);
  assert.equal(openPanel.props.children[1].props.children,frame);
});
