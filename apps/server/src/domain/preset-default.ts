const definitions = [
  ['main','主指令','system',true,'你是虚构世界的叙事引擎。依据世界设定和已发生的故事连贯推进叙事。'],
  ['personaInfo','玩家角色','system',true],
  ['characterInfo','其他角色','system',true],
  ['worldState','世界状态','system',true],
  ['chatHistory','历史消息','auto',true],
  ['userInput','用户输入','user',true],
  ['postHistory','后置指令','system',false,''],
] as const;
export const builtinPreset = {
  name:'基础默认', description:'内置纯文本叙事预设', api_model_config_id:null,
  budget:{max_output_tokens:1024}, summary_prompt:'总结已经发生的剧情、人物关系、重要承诺和未解决线索。',
  nodes:definitions.map(([id,name,role,enabled,...content])=>({id,kind:'system',name,source:id,role,enabled,...(content.length ? {content:content[0]} : {})})),
};
