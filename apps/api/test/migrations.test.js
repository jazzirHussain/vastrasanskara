import { test, expect } from 'vitest';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { runMigrations } from '../src/core/migrations.js';
import { MODELS } from '../src/models.js';
useTestDb();

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const quiet = { info() {}, error() {} };

test('indexes are built for every model', async () => {
  await mongoose.connection.db.dropDatabase();
  const { indexes } = await runMigrations({ models: MODELS, migrations: [], log: quiet });
  expect(indexes).toEqual(MODELS.map((m) => m.modelName));
  const names = (await mongoose.connection.collection('auditLog').indexes()).map((i) => i.name);
  expect(names.length).toBeGreaterThan(1);
});

test('a migration runs once and is recorded', async () => {
  let runs = 0;
  const migrations = [{ id: '900-test', up: async (db) => { runs += 1; await db.collection('scratch').insertOne({ n: runs }); } }];
  expect((await runMigrations({ models: [], migrations, log: quiet })).applied).toEqual(['900-test']);
  expect((await runMigrations({ models: [], migrations, log: quiet })).applied).toEqual([]);
  expect(runs).toBe(1);
  expect(await mongoose.connection.collection('migrations').findOne({ _id: '900-test' })).toMatchObject({ _id: '900-test' });
});

test('a failing migration is not recorded and stops the run', async () => {
  let afterRan = false;
  const migrations = [
    { id: '901-bad', up: async () => { throw new Error('boom'); } },
    { id: '902-after', up: async () => { afterRan = true; } },
  ];
  await expect(runMigrations({ models: [], migrations, log: quiet })).rejects.toThrow(/901-bad.*boom/);
  expect(afterRan).toBe(false);
  expect(await mongoose.connection.collection('migrations').countDocuments()).toBe(0);
});

test('every module model is listed for migrations', async () => {
  const files = [
    ...readdirSync(path.join(SRC, 'modules')).map((m) => path.join(SRC, 'modules', m, 'model.js')),
    ...readdirSync(path.join(SRC, 'core'), { recursive: true })
      .filter((f) => /(^|[\\/])models?\.js$/.test(f))
      .map((f) => path.join(SRC, 'core', f)),
  ].filter((f) => existsSync(f));
  expect(files.length).toBeGreaterThan(15);
  const listed = new Set(MODELS.map((m) => m.modelName));
  for (const file of files) {
    const mod = await import(pathToFileURL(file).href);
    for (const value of Object.values(mod)) {
      if (typeof value === 'function' && value.prototype instanceof mongoose.Model && !value.baseModelName) {
        expect(listed.has(value.modelName), `${value.modelName} from ${path.relative(SRC, file)}`).toBe(true);
      }
    }
  }
});
