import { test, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { planStages, DEFAULT_SETTINGS } from '@vs/shared';
import { theme } from '../theme.js';
import { StageThread } from './StageThread.jsx';
import { Money } from './Money.jsx';
import { DateLabel } from './DateLabel.jsx';
import { StatusBadge } from './StatusBadge.jsx';
import { EmptyState } from './EmptyState.jsx';

afterEach(() => vi.useRealTimers());
const wrap = (ui) => render(<MantineProvider theme={theme}>{ui}</MantineProvider>);
const { stagePlan } = planStages({ orderDate: '2026-10-01', dueDate: '2026-11-15', durations: DEFAULT_SETTINGS.stageDurations.default });

test('StageThread marks done, current and late stages accessibly', () => {
  wrap(<StageThread stagePlan={stagePlan} currentStage="handwork" status="in_progress" late variant="compact" />);
  expect(screen.getByRole('img', { name: 'Stage 4 of 14: Handwork' })).toBeInTheDocument();
  expect(screen.getByLabelText('Pattern making: done')).toBeInTheDocument();
  expect(screen.getByLabelText('Handwork: current, late')).toBeInTheDocument();
  expect(screen.getByLabelText('Tailors: upcoming')).toBeInTheDocument();
});
test('StageThread treats a just-taken order as waiting for materials', () => {
  wrap(<StageThread stagePlan={stagePlan} currentStage="order_taken" status="in_progress" variant="full" />);
  expect(screen.getByRole('group', { name: 'Stage 2 of 14: Materials ready' })).toBeInTheDocument();
  expect(screen.getByLabelText('Order taken + advance: done')).toBeInTheDocument();
  expect(screen.getByLabelText('Materials ready: current')).toBeInTheDocument();
  expect(screen.getByText('Handwork')).toBeInTheDocument();
});
test('StageThread shows a finished garment as complete', () => {
  wrap(<StageThread stagePlan={stagePlan} currentStage="picked_up" status="picked_up" variant="compact" />);
  expect(screen.getByRole('img', { name: 'Picked up' })).toBeInTheDocument();
  expect(screen.getByLabelText('Packaging: done')).toBeInTheDocument();
});
test('Money renders nothing without a value', () => {
  wrap(<Money paise={undefined} />);
  expect(screen.queryByText(/₹/)).toBeNull();
  wrap(<Money paise={12345650} />);
  expect(screen.getByText('₹1,23,456.50')).toBeInTheDocument();
});
test('DateLabel says today, in 3 days and 2 days late', () => {
  vi.useFakeTimers({ now: new Date('2026-11-11T20:00:00Z'), toFake: ['Date'] }); // 01:30 IST on 12 Nov
  wrap(
    <>
      <DateLabel ymd="2026-11-12" />
      <DateLabel ymd="2026-11-15" />
      <DateLabel ymd="2026-11-10" />
      <DateLabel ymd="2027-01-05" />
    </>,
  );
  expect(screen.getByText('Thu 12 Nov')).toBeInTheDocument();
  expect(screen.getByText('today')).toBeInTheDocument();
  expect(screen.getByText('Sun 15 Nov')).toBeInTheDocument();
  expect(screen.getByText('in 3 days')).toBeInTheDocument();
  expect(screen.getByText('2 days late')).toBeInTheDocument();
  expect(screen.getByText('Tue 5 Jan 2027')).toBeInTheDocument();
});
test('StatusBadge uses sentence case labels', () => {
  wrap(<><StatusBadge status="on_hold" /><StatusBadge status="tight" /></>);
  expect(screen.getByText('On hold')).toBeInTheDocument();
  expect(screen.getByText('Tight schedule')).toBeInTheDocument();
});
test('EmptyState shows the next step', () => {
  wrap(<EmptyState title="No orders yet" body="Take the first order." />);
  expect(screen.getByRole('heading', { name: 'No orders yet' })).toBeInTheDocument();
  expect(screen.getByText('Take the first order.')).toBeInTheDocument();
});
