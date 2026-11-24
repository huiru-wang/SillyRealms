import {i18n} from '../../i18n/instance.ts';
import type {Json} from '@sillyrealms/sdk/state-validation';

export type InitialValueNode = {key: string; path: string; value: Json};
export const INITIAL_ARRAY_PAGE_SIZE = 20;

export function initialValueSize(value: Json): number {
  return value !== null && typeof value === 'object' ? (Array.isArray(value) ? value.length : Object.keys(value).length) : 0;
}

/** Enumerate real snapshot members only, never rules or [] templates. */
export function initialValueChildren(node: InitialValueNode, limit = INITIAL_ARRAY_PAGE_SIZE): InitialValueNode[] {
  if (Array.isArray(node.value)) return node.value.slice(0, limit).map((value, index) => ({key: i18n.t('worlds:itemIndex',{index:index+1}), path: `${node.path}[${index}]`, value}));
  if (node.value === null || typeof node.value !== 'object') return [];
  return Object.entries(node.value).map(([key, value]) => ({key, path: node.path + '.' + key, value}));
}

export function initialValueText(value: Json): string {
  if (value === null) return i18n.t('worlds:notDetermined');
  if (typeof value === 'boolean') return value ? i18n.t('worlds:yes') : i18n.t('worlds:no');
  if (typeof value === 'string') return value === '' ? i18n.t('worlds:emptyText') : value;
  if (typeof value === 'number') return String(value);
  return Array.isArray(value) ? (value.length ? i18n.t('worlds:itemCount',{count:value.length}) : i18n.t('worlds:noItems')) : (Object.keys(value).length ? i18n.t('worlds:itemCount',{count:Object.keys(value).length}) : i18n.t('worlds:noFields'));
}

export function initialTextPreview(text: string): {text: string; shortened: boolean} {
  const lines = text.split('\n');
  const preview = lines.slice(0, 4).join('\n');
  // Array.from avoids splitting surrogate pairs in author text.
  const characters = Array.from(preview);
  const shortened = lines.length > 4 || characters.length > 240;
  return {text: shortened ? characters.slice(0, 240).join('') + '…' : text, shortened};
}
