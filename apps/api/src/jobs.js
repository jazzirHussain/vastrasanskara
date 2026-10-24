// Every scheduled background job. Each area defines its jobs in its own jobs.js; importing
// this file registers them all, and the worker schedules whatever is registered.
// Add new job files here.
import './core/jobs/jobs.js';
import './core/notify/jobs.js';
import './core/backup/jobs.js';
import './modules/production/jobs.js';
