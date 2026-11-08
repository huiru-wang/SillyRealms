import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {randomId} from '../src/random-id';

test('generates distinct UUID v4 identifiers using getRandomValues', () => {
  const ids = new Set(Array.from({length: 100}, randomId));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
