export type ContextStrategy = 'compact' | 'standard' | 'extended';
export type PresetRole = 'system' | 'user' | 'assistant';

export type PresetCustomNode = {
  id: string;
  name: string;
  role: PresetRole;
  content: string;
  enabled: boolean;
};

export type StudioPreset = {
  id: string;
  name: string;
  description: string;
  contextStrategy: ContextStrategy;
  maxOutputTokens: number;
  temperature: number;
  summaryPrompt: string;
  style: {content: string; enabled: boolean};
  customNodes: PresetCustomNode[];
};

export const DEFAULT_PRESET_ID = 'longform-narrative';
export const DEFAULT_SUMMARY_PROMPT = '概括已经发生的关键事件、人物关系的变化和仍未解决的线索。保留时间、地点与明确承诺，区分事实和人物猜测，使用简洁的中文。';

const ensembleNotes: Array<[string,string,string]> = [
  ['viewpoint','视角边界','每个场景选定清晰的观察视角，只呈现该人物能够感知或合理推断的信息。'],
  ['voices','人物声线','让不同人物拥有可辨认的措辞、语速和表达习惯，避免所有角色使用同一种语气。'],
  ['motives','人物动机','人物的行动应从既有目标和处境出发；改变立场时呈现足以支撑转变的经历。'],
  ['knowledge','信息差','分别维护人物知道、误解和尚未获知的事情，让信息通过具体事件自然流动。'],
  ['relationships','关系递进','信任、亲近和冲突逐步累积，避免一次对话就彻底改写长期关系。'],
  ['timeline','时间连续','保持时间推进清楚，跨越时段时给出自然过渡，不重复已经完成的事件。'],
  ['places','空间连续','交代人物的位置与移动，保留场所中已经建立的关键物件和出入口。'],
  ['threads','多线交织','让支线与主线通过人物、因果或共同事件产生联系，不为切换而切换。'],
  ['foreshadowing','伏笔铺设','把线索放在可观察的细节中，避免旁白提前宣布它的重要性。'],
  ['payoff','伏笔回收','回收线索时呼应已有事实，保留尚未揭开的部分，不临时补造决定性信息。'],
  ['dialogue','对话推进','让对话同时体现人物意图和关系变化；避免连续大段解释设定。'],
  ['subtext','言外之意','允许人物保留、试探或回避，让动作与语气补充语言之外的信息。'],
  ['consequences','选择后果','让选择产生可感知的后续影响，同时保留人物面对后果时的新选择。'],
  ['rhythm','张弛节奏','在冲突、日常与短暂沉默之间调整节奏，给重要转折留出感受的空间。'],
  ['focus','场景重心','每个场景围绕一个主要变化展开，避免同时推进过多人物与未解决的问题。'],
  ['handoff','自然收束','在一个可回应的动作、问题或局势变化处结束本轮，把下一步选择留给玩家。'],
];

export const presetFixtures: StudioPreset[] = [
  {
    id: DEFAULT_PRESET_ID,
    name: '长叙事预设',
    description: '适合缓慢展开的人物关系与长线故事。保持视角、时间和因果连续，在细节与留白之间推进情节，让人物的每一次选择都能在后续故事中留下真实而自然的影响。',
    contextStrategy: 'extended',
    maxOutputTokens: 4096,
    temperature: 0.9,
    summaryPrompt: '按时间顺序总结关键事件，分别记录主要人物的目标、关系变化、已知信息与未解线索。保留影响后续故事的具体约定，省略重复描写，不添加未发生的事实。',
    style: {
      enabled: true,
      content: '以克制、细腻的中文叙述展开故事。通过可感知的环境、动作和对话呈现人物，不急于解释情绪或替读者总结意义。保持每一场景的视角稳定，让冲突自然生长。',
    },
    customNodes: [
      {id:'longform-boundaries',name:'叙事边界',role:'system',enabled:true,content:'沿用世界与人物已经建立的事实。不要替玩家决定重要行动、情感或承诺；在需要玩家回应的位置自然停下。'},
      {id:'longform-continuity',name:'人物连续性',role:'system',enabled:true,content:'人物只依据自身已知的信息行动。关系、伤势、物品和承诺应保持连续，变化需要在故事中有明确原因。'},
      {id:'longform-dialogue',name:'对话节奏',role:'system',enabled:false,content:'适当增加短句对话与动作间隙，减少连续的长篇独白，让不同人物保有各自的表达习惯。'},
    ],
  },
  {
    id:'general',
    name:'通用叙事',
    description:'在清晰的情节推进和适度的环境描写之间保持平衡。',
    contextStrategy:'standard',
    maxOutputTokens:2048,
    temperature:0.8,
    summaryPrompt:DEFAULT_SUMMARY_PROMPT,
    style:{enabled:true,content:'使用自然、清楚的中文讲述故事。交代必要的人物、场景与行动，让每次回应都带来一点新的信息，同时为玩家保留参与空间。'},
    customNodes:[{id:'general-continuity',name:'事实连续',role:'system',enabled:true,content:'尊重已经发生的事件与明确约定，避免重复介绍已知背景。'}],
  },
  {
    id:'roleplay',
    name:'角色扮演',
    description:'以人物的感知和回应为中心，让对话更有性格与临场感。',
    contextStrategy:'standard',
    maxOutputTokens:3072,
    temperature:1,
    summaryPrompt:'记录人物当前的处境、彼此的关系与尚未说出口的冲突。明确哪些信息已被谁知晓，保留重要对话的含义，不把推测写成事实。',
    style:{enabled:true,content:'从当前角色的感知出发描写故事，以独特的语言习惯、动作和反应体现性格。避免跳出故事解释创作过程。'},
    customNodes:[
      {id:'roleplay-agency',name:'玩家自主',role:'system',enabled:true,content:'玩家的决定、内心和关键动作由玩家自己表达。可以呈现外界反应，但不要替玩家接受邀请、作出承诺或改变立场。'},
      {id:'roleplay-reading',name:'阅读偏好',role:'user',enabled:true,content:'我希望更多通过角色之间的对话和互动理解故事，环境描写简洁但具体。'},
    ],
  },
  {
    id:'mystery',
    name:'悬疑推理',
    description:'围绕可追溯的线索与人物信息差，逐步揭开事件的真相。',
    contextStrategy:'extended',
    maxOutputTokens:3072,
    temperature:0.7,
    summaryPrompt:'分别列出已确认事实、人物证词、待验证推测和未解线索。注明重要线索出现的地点与时间，保留矛盾，不提前补全真相。',
    style:{enabled:true,content:'用准确的细节与克制的气氛描写建立悬念。让线索自然出现在可观察的行动、物品和对话中，不提前宣布结论。'},
    customNodes:[
      {id:'mystery-fairness',name:'线索公平',role:'system',enabled:true,content:'关键推断应能回溯到已经出现的证据，不依靠临时新增的设定解决主要谜题。'},
      {id:'mystery-uncertainty',name:'保留疑点',role:'system',enabled:true,content:'区分旁白确认的事实、人物的说法与玩家尚待验证的判断。'},
    ],
  },
  {
    id:'slice-of-life',
    name:'日常相处',
    description:'关注平凡日子里的小变化，让关系在自然的来往中慢慢生长。',
    contextStrategy:'compact',
    maxOutputTokens:2048,
    temperature:0.95,
    summaryPrompt:'简要记录人物关系、共同经历、近期约定和当前生活安排。保留对彼此有意义的小事，省略重复日常动作。',
    style:{enabled:true,content:'用温和而具体的细节描写日常。让对话保有停顿和未尽之意，不刻意制造重大冲突，也不急于为每个场景作总结。'},
    customNodes:[],
  },
  {
    id:'ensemble-longform',
    name:'群像长篇',
    description:'让多位人物与多条故事线彼此交织，保留各自的立场、秘密和成长轨迹。',
    contextStrategy:'extended',
    maxOutputTokens:6144,
    temperature:0.85,
    summaryPrompt:'按人物与故事线整理关键进展，记录各自目标、知识边界、关系变化和未回收伏笔。保持事件时间顺序，指出故事线之间已形成的联系。',
    style:{enabled:true,content:'以稳定的场景视角讲述多人物故事。让每个人物都有独立动机与表达方式，用具体事件连接故事线，在转场时保留清晰的时间、地点和因果。'},
    customNodes:ensembleNotes.map(([id,name,content])=>({id:'ensemble-'+id,name,role:'system',content,enabled:true})),
  },
  {
    id:'blank',
    name:'空白预设',
    description:'',
    contextStrategy:'standard',
    maxOutputTokens:2048,
    temperature:1,
    summaryPrompt:DEFAULT_SUMMARY_PROMPT,
    style:{enabled:true,content:''},
    customNodes:[],
  },
];
