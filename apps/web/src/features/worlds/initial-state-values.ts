import type {Json} from '@sillyrealms/sdk/state-validation';

export type InitialValueNode = {key: string; path: string; value: Json};
export const INITIAL_ARRAY_PAGE_SIZE = 20;

export function initialValueSize(value: Json): number {
  return value !== null && typeof value === 'object' ? (Array.isArray(value) ? value.length : Object.keys(value).length) : 0;
}

/** Enumerate real snapshot members only, never rules or [] templates. */
export function initialValueChildren(node: InitialValueNode, limit = INITIAL_ARRAY_PAGE_SIZE): InitialValueNode[] {
  if (Array.isArray(node.value)) return node.value.slice(0, limit).map((value, index) => ({key: `第 ${index + 1} 项`, path: `${node.path}[${index}]`, value}));
  if (node.value === null || typeof node.value !== 'object') return [];
  return Object.entries(node.value).map(([key, value]) => ({key, path: node.path + '.' + key, value}));
}

export function initialValueText(value: Json): string {
  if (value === null) return '尚未确定';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value === '' ? '空文本' : value;
  if (typeof value === 'number') return String(value);
  return Array.isArray(value) ? (value.length ? `${value.length} 项` : '暂无条目') : (Object.keys(value).length ? `${Object.keys(value).length} 项` : '暂无字段');
}

export function initialTextPreview(text: string): {text: string; shortened: boolean} {
  const lines = text.split('\n');
  const preview = lines.slice(0, 4).join('\n');
  // Array.from avoids splitting surrogate pairs in author text.
  const characters = Array.from(preview);
  const shortened = lines.length > 4 || characters.length > 240;
  return {text: shortened ? characters.slice(0, 240).join('') + '…' : text, shortened};
}
