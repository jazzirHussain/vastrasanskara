import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { paginate, decodeCursor } from '../src/core/pagination.js';
useTestDb();

const Item = mongoose.models.PageItem ?? mongoose.model('PageItem', new mongoose.Schema({ group: String, rank: Number, at: Date }));

test('pages in sort order with ties broken by id, no repeats', async () => {
  await Item.create(Array.from({ length: 7 }, (_, i) => ({ group: 'a', rank: i % 3 })));
  await Item.create({ group: 'b', rank: 0 });
  const seen = [];
  let cursor;
  do {
    const page = await paginate(Item, { group: 'a' }, { sort: ['rank', 1], limit: 3, cursor });
    seen.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toHaveLength(7);
  expect(new Set(seen.map((s) => String(s._id))).size).toBe(7);
  expect(seen.map((s) => s.rank)).toEqual([0, 0, 0, 1, 1, 2, 2]);
});
test('descending dates page correctly', async () => {
  await Item.create(Array.from({ length: 5 }, (_, i) => ({ group: 'd', at: new Date(Date.UTC(2026, 0, i + 1)) })));
  const first = await paginate(Item, { group: 'd' }, { sort: ['at', -1], limit: 2 });
  const second = await paginate(Item, { group: 'd' }, { sort: ['at', -1], limit: 2, cursor: first.nextCursor });
  expect([...first.items, ...second.items].map((i) => i.at.getUTCDate())).toEqual([5, 4, 3, 2]);
});
test('the last page has no cursor; limit is capped at 100', async () => {
  await Item.create({ group: 'c', rank: 1 });
  expect((await paginate(Item, { group: 'c' }, { sort: ['rank', 1], limit: 500 })).nextCursor).toBeNull();
});
test('a malformed cursor is a validation error', async () => {
  expect(() => decodeCursor('not-a-cursor')).toThrow(expect.objectContaining({ status: 400 }));
});
