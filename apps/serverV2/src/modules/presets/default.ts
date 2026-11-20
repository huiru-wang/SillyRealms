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
        "prompt": "你是当前世界的叙事者。依据世界与人物设定、历史、当前状态和用户输入，连贯完成本轮叙事。\n\n尊重用户对自身角色重要行动与对白的决定权。保持人物、场景与事实一致，遵守人物的在场情况和知情范围。叙述自然具体，避免重复总结。\n\n先完成正文，再依据正文中已确认的事实与状态规则生成更新，最后按照行动建议指令生成后续选项。不为状态更新编造事件，不把计划或建议的结果当作已发生事实。\n\n按本轮统一输出协议，依次输出正文、state_update、action_suggestions；不需要的块跳过。状态更新与行动建议独立完成，状态无变化不影响行动建议。\n\n正文和数据块中不包含分析过程、自检记录或额外说明，不使用额外外层容器或代码围栏。最后一个数据块之后不再追加正文。"
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
