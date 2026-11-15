import { useNavigate } from 'react-router-dom';
import { Text } from '@mantine/core';
import { formatINR } from '@vs/shared/money.js';
import { HBars } from '../../../components/charts/HBars.jsx';
import { TileCard, barLink } from './TileCard.jsx';

/** Spending by category in the period. */
export function ExpensesTile({ tile, filters }) {
  const navigate = useNavigate();
  const figure = tile.metrics?.expense_categories;
  const rows = (figure?.breakdown ?? []).map((c) => ({ key: c.key, label: c.label, value: c.amount, display: formatINR(c.amount) }));
  return (
    <TileCard title="Spending" explain="Expenses this period, by category." tile={tile} metric="expense_categories" filters={filters}>
      {rows.length ? (
        <HBars label="Spending by category" rows={rows} onSelect={(key) => navigate(barLink('expense_categories', filters, key))} />
      ) : (
        <Text c="var(--vs-muted)">No expenses in this period.</Text>
      )}
    </TileCard>
  );
}
