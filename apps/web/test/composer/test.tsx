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
function edit(text:string){document.execCommand('insertText',false,text);}
function key(key:string, options:KeyboardEventInit={}){document.querySelector('[contenteditable]')!.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options}));}
function selectEnd(){const e=document.querySelector('[contenteditable]')!;const sel=window.getSelection()!,range=document.createRange();range.selectNodeContents(e);range.collapse(false);sel.removeAllRanges();sel.addRange(range);(e as HTMLElement).focus();}
async function run(name:string, test:()=>Promise<void>){try{await test();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:String(e)});}}
createRoot(document.getElementById('root')!).render(<App/>);
void (async()=>{
 await pause();
 await run('inserting a speech block in the middle preserves prefix and suffix', async()=>{
  setExternal('走进房间'); await pause(); const e=document.querySelector<HTMLElement>('[contenteditable]')!; e.focus(); await pause();
  const text=document.createTreeWalker(e.querySelector('p')!,NodeFilter.SHOW_TEXT).nextNode();assert(text,`editor HTML: ${e.innerHTML}`);
  const selection=window.getSelection()!,range=document.createRange();range.setStart(text,2);range.collapse(true);selection.removeAllRanges();selection.addRange(range);await pause();
  document.querySelector<HTMLButtonElement>('.sr-composer-tool-speech')!.click();await pause();
  const block=document.querySelector<HTMLElement>('.sr-composer-speech')!;
  assert(block.tagName==='P',`typed node should be block-level: ${block.outerHTML}`);
  edit('有危险');await pause();
  assert(block.textContent==='有危险',`typed text not inserted: ${block.outerHTML}`);
  const value=document.querySelector('#draft')!.textContent!;
  assert(value.includes('走进')&&value.includes('房间')&&value.includes('“有危险”'),value);
 });
 await run('empty first row is replaced without adding a blank line',async()=>{
  setExternal('');await pause();document.querySelector<HTMLButtonElement>('.sr-composer-tool-speech')!.click();await pause();
  const editor=document.querySelector<HTMLElement>('[contenteditable]')!;
  assert(editor.querySelectorAll('p').length===1,editor.innerHTML);
  assert(editor.querySelector('p')?.classList.contains('sr-composer-speech'),editor.innerHTML);
 });
 await run('Enter exits a single-line block and places the caret in ordinary narration',async()=>{
  edit('你好');await pause();key('Enter');await pause();
  const block=document.querySelector<HTMLElement>('.sr-composer-speech')!;
  assert(block.textContent==='你好',`type block should remain one line: ${block.outerHTML}`);
  const selection=window.getSelection();
  assert(selection?.anchorNode && !block.contains(selection.anchorNode),'caret did not leave the type block');
  edit('他转身离开');await pause();
  const value=document.querySelector('#draft')!.textContent!;
  assert(value.includes('“你好”')&&value.includes('他转身离开'),value);
 });
 await run('Cmd+Enter sends while plain Enter only creates a newline',async()=>{
  sent='';setExternal('第一行');await pause();selectEnd();key('Enter');await pause();assert(!sent,'plain Enter sent the message');
  edit('第二行');await pause();key('Enter',{metaKey:true});await pause();assert(sent.includes('第一行')&&sent.includes('第二行'),sent);
 });
 await run('instruction is a block, exits to narration, and can be moved back to tail',async()=>{
  setExternal('旁白');await pause();selectEnd();document.querySelector<HTMLButtonElement>('.sr-composer-tool-instruction')!.click();await pause();edit('保持克制');await pause();
  const instruction=document.querySelector<HTMLElement>('.sr-composer-instruction')!;
  assert(instruction.tagName==='P',instruction.outerHTML);key('Enter');await pause();edit('继续叙事');await pause();
  let value=document.querySelector('#draft')!.textContent!;
  assert(value.indexOf('<sr_instruction>')<value.indexOf('继续叙事'),value);
  document.querySelector<HTMLButtonElement>('.sr-composer-tool-instruction')!.click();await pause();
  value=document.querySelector('#draft')!.textContent!;
  assert(value.indexOf('<sr_instruction>')>value.indexOf('继续叙事'),value);
 });
 await run('multiline paste inside a type block is kept on one line',async()=>{
  setExternal('');await pause();document.querySelector<HTMLButtonElement>('.sr-composer-tool-speech')!.click();await pause();
  const transfer=new DataTransfer();transfer.setData('text/plain','第一行\n第二行');
  document.querySelector<HTMLElement>('[contenteditable]')!.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));await pause();
  assert(document.querySelector('.sr-composer-speech')?.textContent==='第一行 第二行',document.querySelector('[contenteditable]')!.innerHTML);
 });
 await run('legacy thought draft renders as ordinary text, not a typed input block',async()=>{
  setExternal('前文\n\n> 旧内心\n\n“对白”\n\n后文\n\n<sr_instruction>\n缓慢\n</sr_instruction>');await pause();
  const editor=document.querySelector<HTMLElement>('[contenteditable]')!;
  assert(!editor.querySelector('.sr-composer-thought'),'thought input block should not exist');
  assert(editor.textContent?.includes('> 旧内心'),'legacy text should remain visible');
  assert(editor.querySelectorAll('.sr-composer-speech').length===1,'missing speech block');
  assert(editor.querySelectorAll('.sr-composer-instruction').length===1,'missing instruction block');
 });
 document.getElementById('results')!.textContent=JSON.stringify(results);
})();
