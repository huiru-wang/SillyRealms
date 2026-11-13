export type SessionSample={id:string;worldId:string;title:string;world:string;cover:string;subtitle:string;preview:string;custom:boolean};
export const sessionSamples:SessionSample[]=[
  {id:'changan',worldId:'changan',title:'初入长安',world:'长安风云',cover:'/covers/changan.webp',subtitle:'一封没有署名的信',preview:'暮色正沿着朱雀街缓缓落下。',custom:false},
  {id:'neon',worldId:'neon',title:'雨夜重逢',world:'霓虹之城',cover:'/covers/neon.webp',subtitle:'第三区 · 雨夜',preview:'那盏灯还亮着，像是在等一个迟到的人。',custom:true},
];

const extraSessions=['雾中来客','旧日来信','第一班列车','月下初见','深海回声','灯火未眠','雪夜归人','旅店客簿','镜中倒影','电台来信','浮岛之约','茶馆故事','灯塔守望','未完的旅途','黎明之前','遥远的约定','雨后的街道','新的篇章'];
for(let i=0;i<extraSessions.length;i++){
  const base=sessionSamples[i%2];
  sessionSamples.push({...base,id:`mock-session-${i+1}`,title:extraSessions[i],subtitle:'故事继续',preview:'新的故事正在这里展开。'});
}
