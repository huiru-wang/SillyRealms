import {validateWhen, type WhenStateReference} from '@sillyrealms/sdk/when-expression';

export function loreStateReferences(expression: string): WhenStateReference[] | null {
  const references = new Map<string, WhenStateReference>();
  try {
    validateWhen(expression, reference => {
      references.set(JSON.stringify(reference), reference);
    });
  } catch {
    return null;
  }
  return [...references.values()];
}

export function stateReferencePath(parts: string[]): string {
  return parts.map((part, index) => /[.\[\]]/.test(part) ? '[' + JSON.stringify(part) + ']'
    : (index ? '.' : '') + part).join('');
}
