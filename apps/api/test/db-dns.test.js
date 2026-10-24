import { test, expect, vi } from 'vitest';
import dns from 'node:dns';
import mongoose from 'mongoose';
import { connectDb } from '../src/core/db.js';

test('connectDb applies configured DNS servers before connecting', async () => {
  const setServers = vi.spyOn(dns, 'setServers').mockImplementation(() => {});
  const connect = vi.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);
  await connectDb('mongodb+srv://x.example.net/db', { dnsServers: ['1.1.1.1', '8.8.8.8'] });
  expect(setServers).toHaveBeenCalledWith(['1.1.1.1', '8.8.8.8']);
  expect(setServers.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]);
  setServers.mockClear();
  await connectDb('mongodb://localhost/db');
  expect(setServers).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
