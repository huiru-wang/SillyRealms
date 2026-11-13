export type WorldCategory = '多角色' | '古风' | '现代' | '赛博朋克' | '纯文字';
export type World = {
  id: string;
  title: string;
  genre: string;
  description: string;
  cover: string;
  categories: WorldCategory[];
  roleNames?: string[];
};
export const categories: WorldCategory[] = ['多角色','古风','现代','赛博朋克','纯文字'];
export const defaultRoleNames = ['罗斯','凯莉','Robin','詹姆斯','清月','安娜','林恩','艾琳','查理','伊莎贝拉'];
const changanRoleNames = [
  ...defaultRoleNames,
  '沈砚','陆昭','裴清','谢衡','柳如烟','顾长宁','苏晚','秦川','萧景','江蓠',
];
export const worlds: World[] = [
  {id:'changan',title:'长安风云',genre:'古风 · 权谋',description:'大唐长安，一座汇集权谋与江湖故事的繁华古城。',cover:'/covers/changan.webp',categories:['多角色','古风'],roleNames:changanRoleNames},
  {id:'xinghai',title:'星海市',genre:'现代 · 都市',description:'霓虹初上，发生在海滨城市的当代故事。',cover:'/covers/xinghai.webp',categories:['多角色','现代']},
  {id:'neon',title:'霓虹之城',genre:'赛博朋克 · 科幻',description:'科技照亮深夜，城市的秘密藏在雨中。',cover:'/covers/neon.webp',categories:['多角色','赛博朋克']},
  {id:'qinghe',title:'青禾小镇',genre:'田园 · 治愈',description:'一处被山风与田野环抱的宁静小镇。',cover:'/covers/qinghe.webp',categories:['多角色']},
  {id:'yunshang',title:'云上之城',genre:'奇幻 · 冒险',description:'漂浮于云海上的城市，正在等待新的旅人。',cover:'/covers/yunshang.webp',categories:['多角色']},
  {id:'beijing',title:'北境边城',genre:'古风 · 战争',description:'风雪与烽烟交织的边塞传奇。',cover:'/covers/beijing.webp',categories:['多角色','古风']},
  {id:'eden',title:'新伊甸',genre:'科幻 · 探索',description:'在未来文明的尽头寻找另一种可能。',cover:'/covers/eden.webp',categories:['多角色']},
  {id:'forest',title:'遗忘之森',genre:'奇幻 · 神秘',description:'密林深处，有些故事仍未被人记起。',cover:'/covers/forest.webp',categories:['多角色']},
];

const extraWorldNames=['雾港来信','白昼列车','月下书院','深海档案','旧城灯火','雪原驿站','银河旅店','镜中花园','长夜电台','浮岛纪事','山海茶馆','远方灯塔'];
export const mockWorlds:World[]=[...worlds,...extraWorldNames.map((title,index)=>{
  const base=worlds[index%worlds.length];
  return {...base,id:`mock-world-${index+1}`,title,description:`${title}的故事，等待新的旅人。`,roleNames:undefined};
})];
