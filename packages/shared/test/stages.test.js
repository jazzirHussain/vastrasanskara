import { test, expect } from 'vitest';
import { STAGES, STAGE_KEYS, stageIndex } from '../src/stages.js';
test('stage order', () => {
  expect(STAGES).toHaveLength(14);
  expect(STAGE_KEYS[0]).toBe('order_taken');
  expect(stageIndex('trials_fittings')).toBe(7);
  expect(() => stageIndex('nope')).toThrow();
});
