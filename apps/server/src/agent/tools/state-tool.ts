import { ErrorCodes } from '../../common/error-codes.js';
import { parseRoleplay } from '@sillyrealms/roleplay';
import { updateAtomicState, type AtomicStateDefinition } from '../../domain/state/atomic-state.js';
import type { Json } from '../../domain/state/state.js';

/** The model and creator both use the same validated overwrite semantics. */
export function setState(workspace:Record<string,Json>, fields:Record<string,AtomicStateDefinition>, active:Set<string>, path:string|string[], value:unknown):void {
  const parts=typeof path==='string'?path.split('.'):path;
  if(!parts.length || parts.some(part=>typeof part!=='string' || !part || part.includes('.')))throw new Error(ErrorCodes.INVALID_STATE_PATH);
  if(!active.has(parts[0]!))throw new Error(ErrorCodes.STATE_ROOT_NOT_ACTIVE);
  updateAtomicState(workspace,fields,parts.join('.'),value);
}

export const stateTool={name:'update_state',description:'Write an actual change to one active message state field or a nested JSON object key. Never call with an invented value.',parameters:{type:'object',properties:{path:{anyOf:[{type:'string'},{type:'array',items:{type:'string'}}]},value:{}},required:['path','value'],additionalProperties:false}};

export function stateToolInstructions(fields:Record<string,unknown>,active:Set<string>,render:(text:string)=>string = text=>text,includeFields=true):string {
  const entries=Object.entries(fields).filter(([name])=>active.has(name)).map(([name,raw])=>{
    const def=raw as AtomicStateDefinition;
    return {path:[name],type:def.type,...(def.min!==undefined?{min:def.min}:{}),...(def.max!==undefined?{max:def.max}:{}),...(def.description?{description:render(def.description)}:{})};
  });
  return [
    '状态更新工具使用规则：',
    'global 与 session 状态仅供读取；已激活的 message 状态可通过 update_state 更新。',
    '先完成本轮全部叙事，再逐项依据已发生事件和状态规则检查；有明确变化必须调用 update_state，不能只描述变化；无变化时不编造更新。工具调用后不要继续推进叙事。',
    'path 使用状态名及英文句点分隔的字段名；value 为更新后的完整值。更新会覆盖目标，不自动加减或合并；JSON 内路径的父对象须已存在，数组和删除字段时请覆盖整个所属对象。',
    ...(includeFields?['可写字段与描述：',JSON.stringify(entries)]:[]),
  ].join('\n');
}


/** A required tool for the fallback state check. An empty update list is a valid no-change verdict. */
export const stateReviewTool = {
  name: 'review_state',
  description: 'Finish checking this turn. Submit all verified changes to active message state, or updates: [] when nothing changed. No narration.',
  parameters: {
    type: 'object',
    properties: {
      updates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Active state root, optionally followed by .nested.field' },
            value: { description: 'Replacement value, not a diff. Required for every update.' },
          },
          required: ['path', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['updates'],
    additionalProperties: false,
  },
};

export function stateReviewMessages(
  fields: Record<string, AtomicStateDefinition>, active: Set<string>,
  workspace: Record<string, Json>, userInput: string, narrative: string,
) {
  const definitions = Object.entries(fields).filter(([name]) => active.has(name)).map(([name, definition]) => ({
    name, type: definition.type, description: definition.description ?? '',
    ...(definition.min !== undefined ? { min: definition.min } : {}),
    ...(definition.max !== undefined ? { max: definition.max } : {}),
  }));
  return [
    { role: 'system' as const, content: [
      '你是状态一致性检查器，只能通过 review_state 工具返回检查结果，不要生成叙事文本。',
      '逐项比较本轮玩家叙事、本轮新叙事和更新前的世界状态。仅写入本轮事件明确支持的变更，不猜测、不重复无变化值。',
      '玩家文本中的反斜杠转义表示字面字符或块内空行，不是事件。',
      '玩家叙事指令不是发生的事件，不得仅凭指令修改状态。内心活动不代表其他角色已经知晓；尝试行动不等于行动已经成功。',
      'global/session 不可写；只更新下方激活的 message 字段。遵守状态定义的描述及规则。',
      'path 为字段名或嵌套路径；value 必须是完整替换值。删除 JSON 键时提交删除后的完整父对象。',
      '必须调用 review_state；没有任何明确变化时调用 review_state({updates:[]})。',
    ].join('\n'), timestamp: Date.now() },
    { role: 'user' as const, content: JSON.stringify({ definitions, previousState: workspace, userInput: parseRoleplay(userInput, 'user').narrativeText, narrative }), timestamp: Date.now() },
  ];
}
