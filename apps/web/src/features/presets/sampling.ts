import {i18n} from '../../i18n/instance.ts';
export const samplingFields = [
  { key: 'temperature', get label() { return i18n.t('presets:temperature'); }, min: 0, max: 2, initial: 1, get help() { return i18n.t('presets:lowerValuesProduceMoreConsistentWording'); } },
  { key: 'topP', label: 'Top P', min: 0, max: 1, initial: 1, get help() { return i18n.t('presets:lowerValuesNarrowTheNextWordChoices'); } },
  { key: 'frequencyPenalty', get label() { return i18n.t('presets:frequencyPenalty'); }, min: -2, max: 2, initial: 0, get help() { return i18n.t('presets:positiveValuesDiscourageRepeatedWordsMoreStrongly'); } },
  { key: 'presencePenalty', get label() { return i18n.t('presets:presencePenalty'); }, min: -2, max: 2, initial: 0, get help() { return i18n.t('presets:positiveValuesReduceTheChanceOfReusing'); } },
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
  if (!Number.isFinite(number)) return i18n.t('presets:invalidSamplingValue',{label:field.label});
  if (number < field.min || number > field.max) return i18n.t('presets:samplingRange',{label:field.label,min:field.min,max:field.max});
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
