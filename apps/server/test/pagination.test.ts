import { expect, it } from 'vitest';
import { pageByUpdated } from '../src/common/pagination.js';

it('uses stable updated-at and ID cursors, and rejects cursors from another list', () => {
  const rows=[{id:'c',updated_at:10},{id:'b',updated_at:10},{id:'a',updated_at:9}];
  const first=pageByUpdated(rows,'worlds','1'); expect(first.items.map(row=>row.id)).toEqual(['c']);
  const second=pageByUpdated(rows,'worlds','1',first.nextCursor!); expect(second.items.map(row=>row.id)).toEqual(['b']);
  const third=pageByUpdated(rows,'worlds','1',second.nextCursor!); expect(third.items.map(row=>row.id)).toEqual(['a']); expect(third.nextCursor).toBeNull();
  expect(()=>pageByUpdated(rows,'sessions','1',first.nextCursor!)).toThrow();
});
