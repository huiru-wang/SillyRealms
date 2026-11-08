import {renderWorldDocument as render} from '../../../../packages/sr-sdk/src/world-document/render.ts';
const results=[];
function test(name, fn){try{let res=fn();results.push({name,pass:!!res});}catch(e){results.push({name,pass:false,error:String(e)});}}
const el=html=>{const n=document.createElement('div');n.innerHTML=html;return n;};
const run=(s,profile='document')=>render(s,{profile});
test('mixed markdown and html',()=>{let n=el(run('## 标题\n\n段落 **粗体**\n\n<div>卡片</div>\n\n> 引用').html);return !!n.querySelector('h2,strong,div,blockquote')&&n.querySelectorAll('h2,strong,div,blockquote').length===4});
test('marked container',()=>!!el(run('<div data-sr-markdown="true">**粗体**</div>').html).querySelector('strong'));
test('code stays literal',()=>!el(run('```html\n<script>alert(1)</script>\n```').html).querySelector('script'));
test('html event and forbidden elements',()=>!el(run('<script>alert(1)</script><img src="https://a.test/a" onerror="alert(1)"><iframe src="https://a.test"></iframe><form><input></form><svg><script>alert(1)</script></svg>').html).querySelector('script,iframe,form,input,svg,[onerror]'));
test('dangerous links and media',()=>{let n=el(run('<a href="javascript:alert(1)">a</a><img src="data:image/svg+xml,x" srcset="https://x 1x"><a href="https://a.test" target="_top">ok</a>').html);return !n.querySelector('a[href^="javascript"],img[src],img[srcset],a[target="_top"]')&&n.querySelector('a[href^="https"]')?.getAttribute('rel')==='noopener noreferrer'});
test('stylesheet rules',()=>{let r=run('<!doctype html><html><head><style>@import "https://evil"; .ok {color:red;background:url(https://evil);position:fixed} </style></head><body><p>hello</p></body></html>');return r.head.includes('color')&&!/url|@import|position/i.test(r.head)});
test('inline profile excludes style',()=>!run('<style>p {color:red}</style><p style="color:red;background:url(https://evil);position:fixed">x</p>','message').html.match(/<style|url|position/));
test('untrusted slot stripped',()=>!el(run('<span data-sr-slot="bad">x</span>','message').html).querySelector('[data-sr-slot]'));
test('nested marked containers',()=>{let n=el(run('<div data-sr-markdown="true">**outer** <span data-sr-markdown="true">**inner**</span></div>').html);return n.querySelectorAll('strong').length===2});
test('escaped css resource removed',()=>{let r=run('<!doctype html><html><head><style>.x{background: u\\72l(https://evil.test/x);color:red}</style></head><body>x</body></html>');return !/url|evil/i.test(r.head)});
document.querySelector('#result').textContent=JSON.stringify(results);
