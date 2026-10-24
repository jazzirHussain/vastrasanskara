import { test, expect } from 'vitest';
import * as shared from '@vs/shared';
test('shared package loads', () => { expect(shared).toBeTypeOf('object'); });
