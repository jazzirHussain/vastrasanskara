import { test, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { formatINR } from '@vs/shared/money.js';
import { theme } from '../../theme.js';
import { BarPair } from './BarPair.jsx';
import { HBars } from './HBars.jsx';

const wrap = (ui) => render(createElement(MantineProvider, { theme }, ui));
const SERIES = [{ key: 'a', name: 'Billed' }, { key: 'b', name: 'Collected' }];

test('the paired bars have a legend and a table view with the same numbers', async () => {
  const data = [
    { label: 'Oct 2026', a: 4000000, b: 3500000 },
    { label: 'Nov 2026', a: 5000000, b: 3000000 },
  ];
  wrap(<BarPair title="Billed and collected" data={data} series={SERIES} format={formatINR} />);
  const legend = screen.getByRole('list', { name: 'Legend' });
  expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Billed', 'Collected']);
  // Only the last month is labelled under the bars.
  expect(screen.getByText('Nov 2026')).toBeInTheDocument();
  expect(screen.queryByText('Oct 2026')).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: 'Show Oct 2026' }));
  expect(screen.getByRole('status')).toHaveTextContent(`Oct 2026 · Billed ${formatINR(4000000)} · Collected ${formatINR(3500000)}`);

  await userEvent.click(screen.getByRole('button', { name: 'Show as table' }));
  const table = screen.getByRole('table', { name: 'Billed and collected' });
  const rows = within(table).getAllByRole('row').map((r) => within(r).getAllByRole(r.querySelector('th[scope="col"]') ? 'columnheader' : 'cell').map((c) => c.textContent));
  expect(rows).toEqual([
    ['Month', 'Billed', 'Collected'],
    ['Oct 2026', formatINR(4000000), formatINR(3500000)],
    ['Nov 2026', formatINR(5000000), formatINR(3000000)],
  ]);
  expect(screen.getByRole('button', { name: 'Show as chart' })).toBeInTheDocument();
});

test('horizontal bars are sorted, labelled and tappable', async () => {
  const onSelect = vi.fn();
  wrap(
    <HBars
      label="By source"
      rows={[
        { key: 'walk_in', label: 'Walk-in', value: 2, display: '2' },
        { key: 'instagram', label: 'Instagram', value: 5, display: '5 · 40% became orders' },
        { key: 'referral', label: 'Referral', value: 3, display: '3' },
      ]}
      onSelect={onSelect}
    />,
  );
  const buttons = screen.getAllByRole('button');
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Instagram: 5 · 40% became orders', 'Referral: 3', 'Walk-in: 2']);
  expect(screen.getByText('5 · 40% became orders')).toBeInTheDocument();
  await userEvent.click(buttons[1]);
  expect(onSelect).toHaveBeenCalledWith('referral');
});

test('bars stay visible for zero and tiny values', () => {
  const { container } = wrap(
    <BarPair title="Tiny" data={[{ label: 'Nov 2026', a: 0, b: 1 }, { label: 'Dec 2026', a: 100000000, b: 0 }]} series={SERIES} format={String} />,
  );
  const heights = [...container.querySelectorAll('[data-bar]')].map((b) => Number(b.getAttribute('data-height')));
  expect(heights).toHaveLength(4);
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(2);
  const widths = [...container.querySelectorAll('[data-bar]')].map((b) => Number(b.getAttribute('data-width')));
  for (const w of widths) expect(w).toBeGreaterThanOrEqual(8);

  wrap(<HBars label="Zeros" rows={[{ key: 'a', label: 'Nothing', value: 0, display: '0' }]} onSelect={() => {}} />);
  const bar = document.querySelector('[data-hbar]');
  expect(bar.style.minWidth).toBe('2px');
});
