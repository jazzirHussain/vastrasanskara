import { Agenda } from 'agenda';
import { MongoBackend } from '@agendajs/mongo-backend';
import mongoose from 'mongoose';
import { getJobDefinitions } from './registry.js';
import { runJob } from './runJob.js';

const DRAIN_TIMEOUT_MS = 30_000;

/**
 * Starts Agenda on the Mongoose connection (connect first) and schedules every defined job
 * in IST. Import src/jobs.js first so the definitions exist. stop() lets running jobs
 * finish (up to 30 s) before returning.
 */
export async function startWorker({ config, storage } = {}) {
  const agenda = new Agenda({
    backend: new MongoBackend({ mongo: mongoose.connection.db, collection: 'agendaJobs' }),
    processEvery: '30 seconds',
    defaultConcurrency: 1,
  });

  for (const [name, definition] of getJobDefinitions()) {
    agenda.define(name, async (job) => {
      await runJob(name, { agenda, config, storage, attempt: job.attrs.data?.attempt ?? 1 });
    });
    if (definition.schedule) {
      await agenda.every(definition.schedule, name, undefined, { timezone: 'Asia/Kolkata' });
    }
  }
  await agenda.start();

  // The connection belongs to Mongoose; Agenda must not close it.
  return { agenda, stop: () => agenda.drain({ timeout: DRAIN_TIMEOUT_MS, closeConnection: false }) };
}
