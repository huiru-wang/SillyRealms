import type {Run,RunExtensions,StateScope,StateValue} from '@sillyrealms/sdk';
import type {MessageMatch,MessageRule} from '../../../../../../packages/sr-sdk/src/story-types';

export const previewScenarios = [
  'default','empty','history-error','earlier-error','state-error','send-error',
  'run-failed','state-partial','suggestion-failed','snapshot','gap',
  'component-error','missing-component','page-error','narrow','long-history',
] as const;
export type PreviewScenario = typeof previewScenarios[number];
export type PreviewKind = 'official' | 'composed';
export type PreviewSnapshot = Record<StateScope, Record<string, StateValue>>;

export function readPreviewScenario(search: string): PreviewScenario {
  const value = new URLSearchParams(search).get('previewScenario');
  return previewScenarios.includes(value as PreviewScenario) ? value as PreviewScenario : 'default';
}

export const previewRules: MessageRule[] = [{
  id:'preview-clue', roles:['assistant'], pattern:'\\[\\[线索卡\\]\\]',
  replacement:{type:'component',component:'Clue'},
}, {
  id:'preview-broken', roles:['assistant'], pattern:'\\[\\[缺失组件\\]\\]',
  replacement:{type:'component',component:'Missing'},
}];

export const previewStateDefinitions = {
  schema_version:1,
  scopes:{
    global:{季节:{type:'string',description:'世界中的季节'}},
    session:{章节:{type:'string',description:'当前会话章节'}},
    message:{
      地点:{type:'string',description:'当前场景'},
      时间:{type:'string',description:'场景中的时间'},
      天气:{type:'string',description:'当前天气'},
      线索:{type:'number',description:'已经记录的线索数量'},
      物品:{type:'json',description:'随身物品'},
    },
  },
};

export function createSnapshot(kind:PreviewKind):PreviewSnapshot {
  return {
    global:{季节:kind==='composed'?'深秋':'初秋'},
    session:{章节:kind==='composed'?'第三章 · 雨夜重逢':'第一章 · 长安来信'},
    message:{
      地点:kind==='composed'?'旧城区 · 雨幕酒吧':'平康坊 · 临街茶肆',
      时间:kind==='composed'?'23:41':'戌时',
      天气:kind==='composed'?'小雨，街道湿滑':'雨后微凉',
      线索:3,
      物品:{随身:['没有署名的信','一枚旧铜钱'],备注:'仍有一些细节等待你发现。'},
    },
  };
}

const cityParagraphs = [
  '暮色正沿着朱雀街缓缓落下。街边的灯笼一盏接一盏亮起来，行人收起摊铺，风里带着一点刚落过雨的凉意。',
  '你在城门口收到一封没有署名的信。纸张带着淡淡的墨香，落款处只画着一枚小小的银杏叶。远处传来清脆的梆响。',
  '坊门前的灯火比别处更亮。你穿过人群，留意到一家茶肆的二楼窗边，有人正将一盏茶推向对面的空座。',
  '掌柜没有追问来意，只替你指了指楼梯。木阶轻轻作响，窗外的车马声渐渐远去，故事在这一刻安静下来。',
];
const neonParagraphs = [
  '雨落在玻璃顶棚上，淹没了街道另一端的脚步声。霓虹在积水中散开，又随着经过的车灯缓缓合拢。',
  '林岚把一枚旧芯片推到你面前。金属边缘还留着细小的划痕，像某个人在匆忙中留下的记号。',
  '“你还是来了。”她停顿片刻，望向窗外。“这次，我们可能没有太多时间。”',
  '吧台后的老式收音机传出沙沙声。你没有急着回答，只把那封旧信放在桌上，等她继续说下去。',
];

export function extensions(kind:PreviewKind, state:'unchanged'|'applied'|'partial'|'cancelled'='unchanged', suggestion:'ready'|'failed'|'blocked'|'cancelled'='ready'):RunExtensions {
  return {
    protocol:'sr_extensions/v1',
    stateUpdate:{
      status:state,acceptedCount:state==='applied'||state==='partial'?1:0,
      changedPaths:state==='applied'||state==='partial'?['线索']:[],
      skipped:state==='partial'?[{index:1,errorCode:'STATE_VALUE_INVALID',errorMessage:'合成样例中的无效项'}]:[],
      warningCodes:[],
    },
    actionSuggestions:{
      status:suggestion,warningCodes:[],
      ...(suggestion==='blocked'?{blockedBy:'state_partial' as const}:{}),
      items:suggestion==='ready'?(kind==='composed'?
        ['拿起芯片，询问她这次委托的来历。','望向窗外，确认是否有人跟踪。','把旧信递给她，等待解释。']:
        ['坐到窗边，询问这封信的来历。','暂不表明身份，观察茶肆里的人。','拿出铜钱，问对方是否认得它。']):[],
    },
  };
}

export function createRuns(sessionId:string,kind:PreviewKind,scenario:PreviewScenario):Run[] {
  if(scenario==='empty') return [];
  const count=scenario==='long-history'?100:12;
  const paragraphs=kind==='composed'?neonParagraphs:cityParagraphs;
  return Array.from({length:count},(_,index)=>{
    const runId=sessionId+':history:'+String(index+1).padStart(3,'0');
    let text=paragraphs[index%paragraphs.length]+'\n\n'+paragraphs[(index+1)%paragraphs.length];
    if(index===count-4)text+='\n\n> 信上的字迹很轻，却没有一笔犹豫。\n\n你把这句话记在心里。';
    if(index===count-3)text+='\n\n| 线索 | 你已经知道的事 |\n| --- | --- |\n| 银杏叶 | 与来信上的记号相同 |\n| 旧铜钱 | 边缘刻着不易察觉的字 |\n\n一切似乎都指向同一个地方。';
    if(index===count-2)text+='\n\n<em>夜色里，新的线索正逐渐清晰。</em>\n\n[[线索卡]]';
    if(index===count-1)text+='\n\n对方抬眼望来，像是早已认出了你。故事停在这里，等待你的下一句话。';
    if(scenario==='component-error'&&index===count-1)text+='\n\n[[线索卡]]';
    if(scenario==='missing-component'&&index===count-1)text+='\n\n[[缺失组件]]';
    return {
      id:runId,status:'completed',phase:'finalized',executionMode:'direct',
      messages:[
        ...(index===0?[]:[{id:runId+':user',role:'user' as const,text:index%2===0?'我停下脚步，仔细观察周围的动静。':'我收好来信，继续向前。'}]),
        {id:runId+':assistant',role:'assistant' as const,text},
      ],
      ...(index===count-1?{extensions:extensions(kind)}:{}),
    };
  });
}

/** Fixed fixture spans exercise the real renderer; no author regex runs in this adapter. */
export function previewMatches(text:string,role:'user'|'assistant'):{matches:MessageMatch[];warning:boolean} {
  const matches:MessageMatch[]=[];
  if(role==='assistant'){
    for(const [token,rule] of [['[[线索卡]]',previewRules[0]!],['[[缺失组件]]',previewRules[1]!]] as const){
      let start=text.indexOf(token);
      while(start>=0&&matches.length<50){
        matches.push({start,end:start+token.length,ruleId:rule.id,replacement:rule.replacement,match:token,groups:[],namedGroups:{}});
        start=text.indexOf(token,start+token.length);
      }
    }
  }
  return {matches:matches.sort((a,b)=>a.start-b.start),warning:false};
}

export function responseText(kind:PreviewKind):string {
  return kind==='composed'?
    '林岚听完你的话，轻轻转动桌上的芯片。窗外驶过一辆车，蓝色灯光短暂掠过她的侧脸。\n\n“有些答案，需要亲自去看。”她将旧城区的地图展开，在河岸边画了一个很小的圆。🗝️\n\n[[线索卡]]\n\n雨还在下。你记住那个位置，准备决定接下来的行动。':
    '对方听完你的话，慢慢放下茶盏。窗外的灯笼在风中摇了摇，柔和的光落在桌面上。\n\n“原来信已经送到了。”他将一页旧纸推到你面前，纸上画着城南的一座桥。🗝️\n\n[[线索卡]]\n\n你把这条线索记下来。夜色还长，下一步由你决定。';
}
