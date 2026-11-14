import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RoleplayComposer} from '../../src/features/sessions/composer/RoleplayComposer';
import '../../src/style.css';
import '../../src/design-system/tokens.css';
import '../../src/design-system/studio.css';
import '../../src/features/sessions/composer/roleplay-composer.css';

const results: Array<{name:string;pass:boolean;error?:string}> = [];
let sent = '', setExternal: (value:string)=>void = () => {};
function App(){
  const [value,setValue]=useState(''); setExternal=setValue;
  return <div className="sr-shell"><div className="host-composer"><RoleplayComposer value={value} disabled={false} onChange={setValue} onSubmit={text=>{sent=text;}}/><output id="draft">{value}</output></div></div>;
}
const pause = () => new Promise(resolve=>setTimeout(resolve,80));
function assert(condition: unknown, text: string): asserts condition {if (!condition) throw Error(text);}
function editor(){return document.querySelector<HTMLElement>('[contenteditable]')!;}
function draft(){return document.querySelector('#draft')!.textContent!;}
function edit(text:string){document.execCommand('insertText',false,text);}
function key(key:string, options:KeyboardEventInit={}){editor().dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options}));}
function select(node:HTMLElement=editor(),all=false){
  editor().focus();
  const selection=window.getSelection()!,range=document.createRange();
  range.selectNodeContents(node);if(!all)range.collapse(false);
  selection.removeAllRanges();selection.addRange(range);
}
function paste(text:string){
  const transfer=new DataTransfer();transfer.setData('text/plain',text);
  editor().dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
}
async function run(name:string, test:()=>Promise<void>){try{await test();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:String(e)});}}
createRoot(document.getElementById('root')!).render(<App/>);
void (async()=>{
 await pause();
 await run('the plain editor has no input-type toolbar or hidden shortcut buttons',async()=>{
  assert(!document.querySelector('.sr-composer-toolbar'),'the removed toolbar remains mounted');
  assert(!document.querySelector('.sr-composer-tool'),'input shortcuts should not remain hidden in the DOM');
  assert(editor().getAttribute('role')==='textbox'&&editor().getAttribute('aria-multiline')==='true','editor lost its accessible text input semantics');
  assert(editor().querySelectorAll('p').length===1,editor().innerHTML);
 });
 await run('external semantic drafts preserve narration, editable speech and trailing text', async()=>{
  setExternal('走进房间\n\n“有危险”\n\n后文');await pause();
  const block=document.querySelector<HTMLElement>('.sr-composer-speech');
  assert(block?.tagName==='P','external speech must remain a block-level node');
  select(block);await pause();edit('，别靠近');await pause();
  assert(block.textContent==='有危险，别靠近',block.outerHTML);
  assert(draft().includes('走进房间')&&draft().includes('后文')&&draft().includes('“有危险，别靠近”'),draft());
 });
 await run('resetting to an empty external draft leaves one ordinary row',async()=>{
  setExternal('');await pause();
  assert(editor().querySelectorAll('p').length===1,editor().innerHTML);
  assert(!editor().querySelector('.sr-composer-block'),editor().innerHTML);
 });
 await run('Enter exits an external speech block into ordinary narration',async()=>{
  setExternal('“你好”');await pause();const block=document.querySelector<HTMLElement>('.sr-composer-speech')!;
  select(block);await pause();key('Enter');await pause();
  assert(block.textContent==='你好','speech should stay on one line: '+block.outerHTML);
  const selection=window.getSelection();
  assert(selection?.anchorNode && !block.contains(selection.anchorNode),'caret did not leave the speech block');
  edit('他转身离开');await pause();
  assert(draft().includes('“你好”')&&draft().includes('他转身离开'),draft());
 });
 await run('Cmd and Ctrl Enter send while plain Enter creates a newline',async()=>{
  sent='';setExternal('第一行');await pause();select();key('Enter');await pause();
  assert(!sent,'plain Enter sent the message');edit('第二行');await pause();
  key('Enter',{metaKey:true});await pause();assert(sent.includes('第一行')&&sent.includes('第二行'),sent);
  sent='';key('Enter',{ctrlKey:true});await pause();assert(sent.includes('第二行'),'Ctrl+Enter did not send');
 });
 await run('IME composition does not submit on a send shortcut',async()=>{
  sent='';setExternal('正在输入');await pause();select();
  key('Enter',{metaKey:true,isComposing:true});await pause();
  assert(!sent,'composition shortcut unexpectedly submitted');
  assert(editor().textContent?.includes('正在输入'),'composition shortcut changed the draft');
 });
 await run('external instruction blocks remain editable and Enter exits to narration',async()=>{
  setExternal('旁白\n\n<sr_instruction>\n保持克制\n</sr_instruction>');await pause();
  const instruction=document.querySelector<HTMLElement>('.sr-composer-instruction')!;
  assert(instruction.tagName==='P',editor().innerHTML);select(instruction);await pause();edit('，继续');await pause();
  assert(instruction.textContent==='保持克制，继续',instruction.outerHTML);
  key('Enter');await pause();edit('继续叙事');await pause();
  assert(draft().indexOf('<sr_instruction>')<draft().indexOf('继续叙事'),draft());
  assert(draft().includes('保持克制，继续'),draft());
 });
 await run('multiline paste inside an existing type block remains on one line',async()=>{
  setExternal('“原文”');await pause();select(document.querySelector<HTMLElement>('.sr-composer-speech')!,true);await pause();
  paste('第一行\n第二行');await pause();
  assert(document.querySelector('.sr-composer-speech')?.textContent==='第一行 第二行',editor().innerHTML);
 });
 await run('Backspace removes an empty type block and restores an ordinary caret',async()=>{
  setExternal('“将被删除”');await pause();select(document.querySelector<HTMLElement>('.sr-composer-speech')!,true);await pause();
  document.execCommand('delete');await pause();key('Backspace');await pause();
  assert(!editor().querySelector('.sr-composer-speech'),editor().innerHTML);
  edit('普通旁白');await pause();assert(draft().includes('普通旁白'),draft());
 });
 await run('manually pasted quotes and protocol tags keep their existing plain-text escaping',async()=>{
  setExternal('');await pause();select();paste('“普通对白”\n<sr_instruction>\n保持原文\n</sr_instruction>');await pause();
  assert(!editor().querySelector('.sr-composer-block'),'manual text was silently upgraded to a semantic block');
  assert(editor().textContent?.includes('<sr_instruction>'),'manual tag input was removed');
  assert(draft().includes('\\“普通对白\\”')&&draft().includes('\\<sr_instruction>'),draft());
 });
 await run('legacy thought text and external roleplay blocks remain readable',async()=>{
  setExternal('前文\n\n> 旧内心\n\n“对白”\n\n后文\n\n<sr_instruction>\n缓慢\n</sr_instruction>');await pause();
  assert(!editor().querySelector('.sr-composer-thought'),'thought input block should not exist');
  assert(editor().textContent?.includes('> 旧内心'),'legacy text should remain visible');
  assert(editor().querySelectorAll('.sr-composer-speech').length===1,'missing speech block');
  assert(editor().querySelectorAll('.sr-composer-instruction').length===1,'missing instruction block');
 });
 const output=document.getElementById('results')!;
 output.textContent=JSON.stringify(results);output.dataset.complete='true';
})();
