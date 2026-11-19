import { expect, it } from 'vitest';
import { narrativeQuery } from './narrative-query.js';
import { encodeCursor } from './pagination.js';

it('keeps fixed-size backward pages separate from forward entry progress', () => {
  expect(narrativeQuery('one', {})).toEqual({});
  expect(narrativeQuery('one', { limit: '5', afterSeq: '23' })).toEqual({ afterSeq: 23 });
  const cursor = encodeCursor('narrative:one', { beforeSeq: 19 });
  expect(narrativeQuery('one', { cursor })).toEqual({ beforeSeq: 19 });
  expect(() => narrativeQuery('two', { cursor })).toThrow();
  expect(() => narrativeQuery('one', { cursor, afterSeq: '0' })).toThrow();
  for (const limit of ['0', '1', '6', '100', 'five']) expect(() => narrativeQuery('one', { limit })).toThrow();
  for (const afterSeq of ['-1', '1.2', '', 'Infinity', '9007199254740992']) {
    expect(() => narrativeQuery('one', { afterSeq })).toThrow();
  }
});
