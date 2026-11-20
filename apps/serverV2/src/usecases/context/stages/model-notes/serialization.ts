export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Data cannot close a historical note or introduce a capability tag. */
export function serializeNoteJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' ||
      (typeof item === 'number' && !Number.isFinite(item))) throw new TypeError('Invalid note JSON');
    return item;
  });
  if (text === undefined) throw new TypeError('Invalid note JSON');
  return text.replaceAll('<', '\\u003C').replaceAll('>', '\\u003E')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}
