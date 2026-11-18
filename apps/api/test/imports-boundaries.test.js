import { test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : [path.join(dir, f)]));
const specifiers = (file) => [...readFileSync(file, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

test('the imports module reads other modules only through their services', () => {
  const imports = path.join(SRC, 'modules', 'imports');
  for (const file of walk(SRC).filter((f) => f.endsWith('.js'))) {
    const inside = file.startsWith(imports + path.sep);
    for (const spec of specifiers(file).filter((s) => s.startsWith('.'))) {
      const target = path.resolve(path.dirname(file), spec);
      if (inside) {
        const outside = !target.startsWith(imports + path.sep);
        if (outside && target.includes(`${path.sep}modules${path.sep}`)) {
          expect(path.basename(target), `${path.relative(SRC, file)} imports ${spec}`).toBe('service.js');
        }
      } else if (!['jobs.js', 'app.js', 'models.js'].includes(path.relative(SRC, file))) {
        expect(target.startsWith(imports + path.sep), `${path.relative(SRC, file)} imports ${spec}`).toBe(false);
      }
    }
  }
});
