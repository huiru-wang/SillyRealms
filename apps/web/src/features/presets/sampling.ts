export const samplingFields = [
  { key: 'temperature', label: '温度', min: 0, max: 2, initial: 1, help: '值越低，措辞越稳定。' },
  { key: 'topP', label: 'Top P', min: 0, max: 1, initial: 1, help: '值越低，下一步可选的词越少。' },
  { key: 'frequencyPenalty', label: '频率惩罚', min: -2, max: 2, initial: 0, help: '正值抑制反复用词，重复越多，抑制越强。' },
  { key: 'presencePenalty', label: '存在惩罚', min: -2, max: 2, initial: 0, help: '正值降低已用词再次出现的机会。' },
] as const;
export type SamplingField = typeof samplingFields[number];
export type SamplingKey = SamplingField['key'];
export type SamplingDraft = Partial<Record<SamplingKey, number | string>>;

// Keep partial text in the draft so both Save and Duplicate see exactly what is being edited.
export function samplingNumber(value: number | string): number {
  if (typeof value === 'number') return value;
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ? Number(value) : NaN;
}

export function samplingError(field: SamplingField, value: number | string | undefined): string | null {
  if (value === undefined) return null;
  const number = samplingNumber(value);
  if (!Number.isFinite(number)) return '请输入有效的' + field.label + '数值。';
  if (number < field.min || number > field.max) return field.label + '必须在 ' + field.min + ' 到 ' + field.max + ' 之间。';
  return null;
}

export function samplingValues(draft: SamplingDraft): Partial<Record<SamplingKey, number>> {
  const values: Partial<Record<SamplingKey, number>> = {};
  for (const field of samplingFields) {
    const value = draft[field.key];
    if (value === undefined) continue;
    const error = samplingError(field, value);
    if (error) throw new Error(error);
    values[field.key] = samplingNumber(value);
  }
  return values;
}
