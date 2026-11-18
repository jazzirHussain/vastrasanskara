import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { asOperations } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { dashboardIs } from '../../test/dashboard.js';

// Home is the dashboard (M8): its cases live in features/dashboard/dashboard.test.jsx. The M5/M7
// sections (upcoming pickups, on hold, follow-ups, today's appointments) are now its tiles.
test('home greets the user and shows the dashboard', async () => {
  asOperations();
  dashboardIs();
  renderApp('/');
  expect(await screen.findByRole('heading', { name: 'Welcome, Kavya' })).toBeInTheDocument();
  expect(await screen.findByRole('region', { name: 'Needs attention today' })).toBeInTheDocument();
});
