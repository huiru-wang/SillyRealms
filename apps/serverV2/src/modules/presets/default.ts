import type { PresetValue } from './types.js';
import { defaultPostprocessPrompts } from './postprocess.js';

export const DEFAULT_PRESET_ID = 'sr-default-preset';

// Owned by V2; this template has no runtime dependency on the previous server.
const value: PresetValue = {
  "type": "narrative",
  "name": "标准叙事",
  "description": "基于会话绑定的预设构建上下文。默认使用滚动摘要，启用世界状态更新和缓慢、中速、快速三个行动建议。",
  "config": {
    "schemaVersion": 1,
    "nodes": [
      {
        "id": "main",
        "name": "主提示",
        "kind": "system",
        "role": "system",
        "enabled": true,
        "prompt": "你负责根据世界设定、角色设定、聊天历史和玩家输入继续故事。\n尊重玩家对自己角色行动与对白的控制权，不擅自替玩家作出重要决定。\n保持人物性格、关系、已发生事件和场景信息一致；结合距离、在场情况和角色知情范围判断行为，不让角色无依据地知道秘密或远处发生的事件。\n区分已发生事实与计划、猜测和未完成的尝试，不把行动建议当成已经发生的事件。\n叙述具体、自然，避免重复总结和无关解释；使用与对话一致的语言。\n动作与环境使用普通叙述，实际对白使用中文双引号。\n不输出任务确认、内部分析或规则解释。"
      },
      {
        "id": "personaInfo",
        "name": "用户信息",
        "kind": "system",
        "role": "system",
        "enabled": true,
        "prompt": "<用户信息>\n{{persona.prompt}}\n</用户信息>"
      },
      {
        "id": "characterInfo",
        "name": "角色信息",
        "kind": "system",
        "role": "system",
        "enabled": true,
        "prompt": "<角色信息>\n{{characters.prompts}}\n</角色信息>"
      },
      {
        "id": "worldInfo",
        "name": "世界书",
        "kind": "system",
        "role": "system",
        "enabled": true,
        "prompt": "<世界书>\n{{world.lore}}\n</世界书>"
      },
      {
        "id": "chatHistory",
        "name": "会话历史",
        "kind": "system",
        "role": "auto",
        "enabled": true,
        "prompt": "<已有摘要>\n{{history.summary}}\n</已有摘要>\n{{history.messages}}"
      },
      {
        "id": "userInput",
        "name": "用户输入",
        "kind": "system",
        "role": "user",
        "enabled": true,
        "prompt": "{{input.text}}"
      },
      {
        "id": "worldState",
        "name": "世界状态",
        "kind": "postprocess",
        "role": "system",
        "enabled": true,
        "prompt": defaultPostprocessPrompts.worldState
      },
      {
        "id": "actionSuggestions",
        "name": "行动建议",
        "kind": "postprocess",
        "role": "system",
        "enabled": true,
        "prompt": defaultPostprocessPrompts.actionSuggestions
      }
    ],
    "contextStrategy": {
      "strategy": "rolling_summary",
      "maxContextTokens": 32768,
      "maxOutputTokens": 2048,
      "summaryPrompt": "请将以下聊天历史整理成一份供后续故事续写使用的摘要。\n\n如果历史开头包含已有摘要，请将它与后续对话合并，输出一份完整的新摘要。\n\n摘要要求：\n- 按事件顺序概括重要进展，合并重复信息，省略无关细节。\n- 保留主要人物、人物关系及其重要变化。\n- 保留明确发生的时间、地点、物品和其他关键状态变化；同一信息发生变化时，以最新事实为准。\n- 保留重要约定、当前目标、未解决的冲突和线索。\n- 区分已经发生的事实与计划、猜测、承诺，不把尚未发生的事情写成结果。\n- 不补造信息，不继续故事，不生成行动建议。\n- 使用与聊天历史一致的语言，保持准确、简洁。\n\n只输出摘要正文。"
    },
    "modelParameters": {
      "temperature": 1,
      "thinkingEnabled": false
    }
  }
};

export function defaultPreset(): PresetValue {
  return structuredClone(value);
}
