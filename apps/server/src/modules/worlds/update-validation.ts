import type { StateSchema, StateScope } from '@sillyrealms/sdk/state-validation';
import { AppError } from '../../errors.js';
import type { WorldContent } from './types.js';
import { validateCharacters, validateWorldStateDefinition } from './validation.js';

type ReplacementDefinition = Pick<WorldContent, 'specVersion' | 'publication' | 'characters' | 'stateDefinition'>;

function stateSchema(value: WorldContent['stateDefinition']): StateSchema {
  if (value === null) return { schema_version: 2, scopes: {} };
  validateWorldStateDefinition(value);
  return value;
}

/** Conservative checks for the data retained by an in-place world replacement. */
export function assertWorldReplacementCompatible(
  current: ReplacementDefinition,
  next: ReplacementDefinition,
  playerCharacterIds: readonly string[],
): void {
  const fail = (detail: string): never => { throw new AppError('WORLD_UPDATE_INCOMPATIBLE', detail); };
  if (next.specVersion !== '0.2' ||
    current.publication.package_id !== next.publication.package_id) fail('publication.package_id 或卡片协议不匹配');
  const players = new Set(validateCharacters(next.characters).filter(character => character.player_selectable === true).map(character => character.id));
  for (const id of playerCharacterIds) if (!players.has(id)) fail('会话玩家角色不可用：' + id);
  const before = stateSchema(current.stateDefinition), after = stateSchema(next.stateDefinition);
  const scopes: StateScope[] = playerCharacterIds.length ? ['global', 'session', 'message'] : ['global'];
  for (const scope of scopes) {
    const left = before.scopes[scope] ?? {}, right = after.scopes[scope] ?? {};
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const oldRoot = left[key], newRoot = right[key];
      const path = scope + '.' + key;
      if (!oldRoot || !newRoot) fail('保留状态的根集合不能改变：' + path);
      if (oldRoot!.type !== newRoot!.type) fail('保留状态的根类型不能改变：' + path);
      if (oldRoot!.type === 'number' &&
        ((newRoot!.min ?? -Infinity) > (oldRoot!.min ?? -Infinity) || (newRoot!.max ?? Infinity) < (oldRoot!.max ?? Infinity))) {
        fail('保留状态的数字范围不能收紧：' + path);
      }
    }
  }
}
