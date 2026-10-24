/**
 * Background job definitions. `schedule` is an Agenda interval ('1 minute') or a cron
 * expression evaluated in IST; null means the job only runs when scheduled explicitly.
 * `retries` (one-off jobs) re-runs a failed job after 1, 5 and 15 minutes.
 * `quiet` jobs (frequent housekeeping) log successful runs at debug instead of info.
 */
const jobs = new Map();

export function defineJob(name, { schedule, handler, retries = 0, quiet = false }) {
  jobs.set(name, { name, schedule, handler, retries, quiet });
}

export function getJobDefinitions() {
  return jobs;
}

export function getJobDefinition(name) {
  const definition = jobs.get(name);
  if (!definition) throw new Error(`Unknown job: ${name}`);
  return definition;
}
