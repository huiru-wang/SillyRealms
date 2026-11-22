/** Shared appearance contract. Only validated values cross the renderer boundary. */
export type ThemeMode = 'light' | 'dark';
const darkBase = {
  "canvas": "#1c1a24",
  "canvas-glow": "rgba(107,75,135,.18)",
  "sidebar-bg": "#18161f",
  "sidebar-edge": "rgba(205,196,231,.09)",
  "surface": "#282530",
  "surface-raised": "#302b39",
  "surface-hover": "#35303e",
  "surface-active": "#40364e",
  "stroke": "rgba(222,209,240,.11)",
  "stroke-strong": "rgba(224,209,244,.19)",
  "text": "#f6f3fa",
  "text-secondary": "#c8c2d0",
  "text-muted": "#9993a4",
  "accent": "#ad89d0",
  "accent-soft": "rgba(144,109,174,.23)",
  "accent-selected": "rgba(132,95,168,.28)",
  "focus": "#c6a5e9",
  "shade": "rgba(15,13,21,.65)"
} as const;
const lightBase = {
  "canvas": "#f5f3f7",
  "canvas-glow": "rgba(136,107,172,.09)",
  "sidebar-bg": "#f0edf3",
  "sidebar-edge": "rgba(49,42,63,.10)",
  "surface": "#fdfcfe",
  "surface-raised": "#fff",
  "surface-hover": "#e9e4ee",
  "surface-active": "#e1d8ea",
  "stroke": "rgba(68,55,77,.12)",
  "stroke-strong": "rgba(68,55,77,.22)",
  "text": "#292532",
  "text-secondary": "#61596b",
  "text-muted": "#7b7385",
  "accent": "#76528e",
  "accent-soft": "rgba(131,94,153,.12)",
  "accent-selected": "rgba(131,94,153,.17)",
  "focus": "#8b5eab",
  "shade": "rgba(15,13,21,.56)"
} as const;

function color(value:string):number[]|null {
 if(/^#[\da-f]{3}$/i.test(value))value='#'+[...value.slice(1)].map(c=>c+c).join('');
 const hex=/^#([\da-f]{6})([\da-f]{2})?$/i.exec(value);
 if(hex)return [0,2,4].map(i=>parseInt(hex[1].slice(i,i+2),16)).concat(hex[2]?parseInt(hex[2],16)/255:1);
 const rgb=/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(0?\.\d+|0|1))?\s*\)$/.exec(value);
 if(!rgb)return null;
 const values=[Number(rgb[1]),Number(rgb[2]),Number(rgb[3]),rgb[4]===undefined?1:Number(rgb[4])];
 return values.slice(0,3).every(v=>v>=0&&v<=255)&&values[3]>=0&&values[3]<=1?values:null;
}
function blend(fg:number[],bg:number[]):number[]{return fg.slice(0,3).map((v,i)=>v*fg[3]+bg[i]*(1-fg[3])).concat(1);}
function mix(a:string,b:string,weight:number):string {
 const x=color(a)!,y=color(b)!;
 return '#'+x.slice(0,3).map((v,i)=>Math.round(v*weight+y[i]*(1-weight)).toString(16).padStart(2,'0')).join('');
}
export function contrast(fg:string,bg:string):number {
 const front=color(fg),back=color(bg);if(!front||!back)return 0;
 const luminance=(v:number[])=>v.slice(0,3).reduce((sum,c,i)=>{const n=c/255;return sum+[.2126,.7152,.0722][i]*(n<=.04045?n/12.92:((n+.055)/1.055)**2.4);},0);
 const a=luminance(blend(front,back)),b=luminance(back);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}
function readable(fg:string,bg:string,min=4.5):string {
 const parsed=color(fg)!;
 let value=parsed[3]===1?fg:'#'+blend(parsed,color(bg)!).slice(0,3).map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');const target=contrast('#ffffff',bg)>contrast('#000000',bg)?'#ffffff':'#000000';
 for(let i=0;i<40&&contrast(value,bg)<min;i++)value=mix(value,target,.9);
 return value;
}
type BaseToken=keyof typeof darkBase;
function palette(mode:ThemeMode,overrides:Partial<Record<BaseToken,string>>={}){
 const base:Record<BaseToken,string>={...(mode==='dark'?darkBase:lightBase),...overrides};
 const muted=readable(base['text-muted'],base['surface-hover']);
 const danger=mode==='dark'?'#e99aab':'#a33e52';
 const success=readable('#688f8c',base.surface,6),warning=readable('#bf9475',base.surface,6),info=readable('#8d9db0',base.surface,6);
 return {...base,'text-muted':muted,
  'text-disabled':mix(base.text,base.canvas,.45),'control-border':readable(base['stroke-strong'],base.canvas,3),
  'action-primary-bg':base.accent,'action-primary-fg':readable(base.canvas,base.accent),
  'action-primary-hover':mix(base.accent,base.text,.86),'action-primary-pressed':mix(base.accent,base.text,.72),
  'action-secondary-bg':base['surface-raised'],'action-secondary-fg':base.text,
  'action-secondary-hover':base['surface-hover'],'action-secondary-pressed':base['surface-active'],
  'selection-bg':mix(base.accent,base.canvas,.22),'selection-fg':base.text,'selection-border':base.accent,
  'danger':danger,'danger-bg':mix(danger,base.surface,.12),'danger-action-bg':danger,'danger-action-fg':readable(base.canvas,danger),
  'success':success,'success-bg':mix(success,base.surface,.12),'warning':warning,'warning-bg':mix(warning,base.surface,.12),
  'connection-online':readable('#34b253',base.canvas,3),'connection-offline':readable('#d74242',base.canvas,3),
  'info':info,'info-bg':mix(info,base.surface,.12),
  'glass-bg':mode==='dark'?'rgba(35,32,44,0.88)':'rgba(244,240,248,0.92)',
  'glass-border':base['stroke-strong'],'glass-fallback':base['sidebar-bg'],
  'shadow-color':mode==='dark'?'rgba(0,0,0,.3)':'rgba(31,24,43,.12)',
  'media-bg':'#282735','media-text':'#f6f4f8','media-muted':'rgba(245,243,250,.84)',
  'media-scrim-soft':'rgba(12,12,19,.04)','media-scrim-mid':'rgba(15,15,22,.3)','media-scrim-strong':'rgba(14,14,22,.87)',
  'reading-bg':base.canvas,'reading-surface':base.surface,'reading-text':base.text,'reading-muted':muted,
  'reading-border':base['stroke'],'reading-speech':mode==='dark'?'#efb05d':'#a65b00',
  'usage-system':base.accent,'usage-summary':info,'usage-history':success,'usage-input':base.accent,
  'usage-cache-read':success,'usage-cache-write':info,'usage-output':warning,
  'usage-ink':readable(base.canvas,base.accent),
 };
}
export type ColorToken=keyof ReturnType<typeof palette>;
export type ThemeDefinition={version:1;id:string;name:string;baseMode:ThemeMode;colors?:Partial<Record<ColorToken,string>>};
export type ResolvedTheme={id:string;name:string;mode:ThemeMode;colors:Record<ColorToken,string>};
export const COLOR_TOKENS=Object.keys(palette('dark')) as ColorToken[];
export const builtinTheme=(mode:ThemeMode):ThemeDefinition=>({version:1,id:mode,name:mode==='dark'?'深色':'浅色',baseMode:mode});
const pairs: Array<[ColorToken,ColorToken,number]> = [
 ['text','canvas',4.5],['text','surface',4.5],['text-secondary','surface',4.5],['text-muted','canvas',4.5],['text-muted','surface',4.5],['text-muted','surface-hover',4.5],
 ['action-primary-fg','action-primary-bg',4.5],['action-primary-fg','action-primary-hover',4.5],['action-primary-fg','action-primary-pressed',4.5],
 ['action-secondary-fg','action-secondary-bg',4.5],['action-secondary-fg','action-secondary-hover',4.5],['selection-fg','selection-bg',4.5],
 ['danger','surface',4.5],['danger','danger-bg',4.5],['danger-action-fg','danger-action-bg',4.5],['success','success-bg',4.5],['warning','warning-bg',4.5],['info','info-bg',4.5],
 ['connection-online','canvas',3],['connection-offline','canvas',3],
 ['reading-text','reading-surface',4.5],['reading-muted','reading-surface',4.5],['reading-speech','reading-surface',4.5],['focus','canvas',3],['focus','surface',3],['control-border','canvas',3],
];
export function resolveTheme(input:unknown):ResolvedTheme {
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('主题必须为对象');
 const data=input as ThemeDefinition;
 if(Object.keys(data).some(k=>!['version','id','name','baseMode','colors'].includes(k)))throw Error('主题包含未知字段');
 if(data.version!==1||!['light','dark'].includes(data.baseMode)||typeof data.id!=='string'||!data.id.trim()||data.id.length>64||typeof data.name!=='string'||!data.name.trim()||data.name.length>80)throw Error('主题版本或基本信息无效');
 const overrides:Partial<Record<ColorToken,string>>={};
 if(data.colors!==undefined){
  if(!data.colors||typeof data.colors!=='object'||Array.isArray(data.colors))throw Error('主题颜色无效');
  for(const [key,value] of Object.entries(data.colors)){
   if(!COLOR_TOKENS.includes(key as ColorToken)||typeof value!=='string'||value.length>80||!color(value))throw Error('无效主题颜色：'+key);
   overrides[key as ColorToken]=value;
  }
 }
 const baseOverrides=Object.fromEntries(Object.entries(overrides).filter(([key])=>Object.hasOwn(darkBase,key)));
 const colors:Record<ColorToken,string>={...palette(data.baseMode,baseOverrides),...overrides};
 for(const [fg,bg,min] of pairs)if(color(colors[bg])![3]!==1||contrast(colors[fg],colors[bg])<min)throw Error(`主题对比度不足：${fg} / ${bg}`);
 return {id:data.id,name:data.name,mode:data.baseMode,colors};
}
export function applyTheme(definition:ThemeDefinition,root:HTMLElement=document.documentElement):ResolvedTheme {
 const resolved=resolveTheme(definition); // Validate the whole theme before touching the DOM.
 for(const key of COLOR_TOKENS)root.style.setProperty('--'+key,resolved.colors[key]);
 root.dataset.theme=resolved.mode;root.dataset.themeId=resolved.id;
 root.dispatchEvent(new CustomEvent('sr:appearance-changed',{bubbles:true}));
 return resolved;
}
export function setTheme(definition:ThemeDefinition){
 const resolved=applyTheme(definition);
 try{localStorage.setItem('sr-studio-theme-definition',JSON.stringify(definition));localStorage.setItem('sr-studio-theme',resolved.mode);}catch{/* Session appearance still works. */}
 return resolved;
}
export function initializeTheme(){
 try{const saved=localStorage.getItem('sr-studio-theme-definition');if(saved){applyTheme(JSON.parse(saved));return;}}catch{/* Invalid saved themes fall back without partial application. */}
 let mode:ThemeMode='dark';try{if(localStorage.getItem('sr-studio-theme')==='light')mode='light';}catch{}
 applyTheme(builtinTheme(mode));
}
export type Appearance={version:1;mode:ThemeMode;colors:Record<string,string>};
export function readAppearance():Appearance {
 const css=getComputedStyle(document.documentElement);
 return {version:1,mode:document.documentElement.dataset.theme==='light'?'light':'dark',colors:Object.fromEntries(COLOR_TOKENS.map(k=>['--'+k,css.getPropertyValue('--'+k).trim()]))};
}
/** The renderer accepts appearance values, never CSS source, selectors or API data. */
export function applyAppearance(value:unknown):boolean {
 if(!value||typeof value!=='object')return false;
 const data=value as Appearance;
 if(data.version!==1||!['light','dark'].includes(data.mode)||!data.colors||typeof data.colors!=='object'||Array.isArray(data.colors))return false;
 const entries=Object.entries(data.colors);
 if(entries.length!==COLOR_TOKENS.length||entries.some(([key,v])=>!COLOR_TOKENS.includes(key.slice(2) as ColorToken)||!key.startsWith('--')||typeof v!=='string'||!color(v)))return false;
 for(const [key,v] of entries)document.documentElement.style.setProperty(key,v);
 document.documentElement.dataset.theme=data.mode;
 return true;
}
export const STORY_COLOR_MAP={bg:'reading-bg',surface:'reading-surface',text:'reading-text',muted:'reading-muted',line:'reading-border',accent:'accent',focus:'focus',danger:'danger',speech:'reading-speech'} as const;
