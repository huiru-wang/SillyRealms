export type WorldCategory = '多角色' | '古风' | '现代' | '赛博朋克' | '纯文字';
export type World = {
  id: string;
  title: string;
  genre: string;
  description: string;
  cover: string;
  categories: WorldCategory[];
  sessionCount: number;
};
export const categories: WorldCategory[] = ['多角色','古风','现代','赛博朋克','纯文字'];
export const worlds: World[] = [
  {id:'changan',title:'长安风云',genre:'古风 · 权谋',description:'大唐长安，一座汇集权谋与江湖故事的繁华古城。',cover:'/covers/changan.webp',categories:['多角色','古风'],sessionCount:2},
  {id:'xinghai',title:'星海市',genre:'现代 · 都市',description:'霓虹初上，发生在海滨城市的当代故事。',cover:'/covers/xinghai.webp',categories:['多角色','现代'],sessionCount:2},
  {id:'neon',title:'霓虹之城',genre:'赛博朋克 · 科幻',description:'科技照亮深夜，城市的秘密藏在雨中。',cover:'/covers/neon.webp',categories:['多角色','赛博朋克'],sessionCount:2},
  {id:'qinghe',title:'青禾小镇',genre:'田园 · 治愈',description:'一处被山风与田野环抱的宁静小镇。',cover:'/covers/qinghe.webp',categories:['多角色'],sessionCount:2},
  {id:'yunshang',title:'云上之城',genre:'奇幻 · 冒险',description:'漂浮于云海上的城市，正在等待新的旅人。',cover:'/covers/yunshang.webp',categories:['多角色'],sessionCount:2},
  {id:'beijing',title:'北境边城',genre:'古风 · 战争',description:'风雪与烽烟交织的边塞传奇。',cover:'/covers/beijing.webp',categories:['多角色','古风'],sessionCount:2},
  {id:'eden',title:'新伊甸',genre:'科幻 · 探索',description:'在未来文明的尽头寻找另一种可能。',cover:'/covers/eden.webp',categories:['多角色'],sessionCount:2},
  {id:'forest',title:'遗忘之森',genre:'奇幻 · 神秘',description:'密林深处，有些故事仍未被人记起。',cover:'/covers/forest.webp',categories:['多角色'],sessionCount:2},
];
