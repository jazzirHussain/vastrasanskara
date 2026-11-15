import { Link } from 'react-router-dom';
import { Badge, Group, Text } from '@mantine/core';
import { formatINR } from '@vs/shared/money.js';
import { BarPair } from '../../../components/charts/BarPair.jsx';
import { TileCard, barLink } from './TileCard.jsx';

const SERIES = [
  { key: 'a', name: 'Billed' },
  { key: 'b', name: 'Collected' },
];

/** Billed against collected by month, and who owes what by how late it is. */
export function MoneyTile({ tile, filters }) {
  const months = tile.metrics?.month_money;
  const ageing = tile.metrics?.receivables_ageing;
  return (
    <TileCard title="Money" explain="What you billed and what came in, by month." tile={tile} metric="month_money" filters={filters}>
      {months && (
        <BarPair
          title="Billed and collected by month"
          data={months.breakdown.map((m) => ({ label: m.label, a: m.billed, b: m.collected }))}
          series={SERIES}
          format={formatINR}
        />
      )}
      {ageing && (
        <>
          <Text size="sm" fw={600} mt="sm">
            Owed to you: {formatINR(ageing.amount)}
          </Text>
          <Group gap={6} mt={6}>
            {ageing.breakdown
              .filter((b) => b.amount > 0)
              .map((b) => (
                <Badge key={b.key} component={Link} to={barLink('receivables_ageing', filters, b.key)} variant="light" size="lg" style={{ cursor: 'pointer', textTransform: 'none' }}>
                  {b.label}: {formatINR(b.amount)}
                </Badge>
              ))}
          </Group>
        </>
      )}
    </TileCard>
  );
}
