import { expect, it } from 'vitest';
import { readStateVariable } from './state-variable.js';

it('serializes JSON values and descends only through visible own object keys', () => {
  const views = { message: {}, global: {}, session: {
    data: { '0': false, empty: '', nil: null, items: [0], count: 0 }, hidden: 'secret',
  } };
  const roots = { message: new Set<string>(), global: new Set<string>(), session: new Set(['data', 'absent']) };
  const read = (path: string) => readStateVariable({ type: 'state', scope: 'session', parts: path.split('.') }, views, roots);
  expect(read('data')).toBe(JSON.stringify(views.session.data));
  expect(['data.0', 'data.empty', 'data.nil', 'data.items', 'data.count'].map(read))
    .toEqual(['false', '', 'null', '[0]', '0']);
  for (const path of ['data.items.0', 'data.count.x', 'data.missing', 'data.toString', 'hidden', 'absent']) {
    expect(read(path)).toBe('');
  }
});
