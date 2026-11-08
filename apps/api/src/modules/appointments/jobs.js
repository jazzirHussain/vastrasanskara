import { defineJob } from '../../core/jobs/registry.js';
import { runAppointmentReminders } from './reminders.js';

// Every 15 minutes: day-before and two-hour reminders (deduplicated, so re-runs send nothing twice).
defineJob('appointments-reminders', { schedule: '*/15 * * * *', handler: () => runAppointmentReminders() });
