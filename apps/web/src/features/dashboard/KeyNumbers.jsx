import { SimpleGrid, Text } from '@mantine/core';
import { METRICS } from '@vs/shared/dashboard.js';
import { formatINR } from '@vs/shared/money.js';
import { StatTile } from '../../components/charts/StatTile.jsx';
import { COMPARED_WITH, UNAVAILABLE, notFilteredText } from './copy.js';
import { filterQuery } from './dashboardApi.js';

/** The big value of a key number: a rate, an amount or a count. */
export function figureText(id, figure) {
  if (figure.rate !== undefined) return figure.rate === null ? '—' : `${Math.round(figure.rate / 100)}%`;
  if (figure.amount !== undefined) return formatINR(figure.amount);
  return String(figure.count ?? 0);
}

/** "up ₹12,400 vs last month", "same as last month"; point-in-time figures compare with a month ago. */
export function changeText(id, figure, preset) {
  const { change } = figure;
  if (!change) return null;
  const against = METRICS[id].periodic ? COMPARED_WITH[preset] ?? 'before' : 'a month ago';
  if (change.direction === 'same') return { direction: 'same', text: `same as ${against}` };
  const size = Math.abs(change.diff);
  let amount;
  if (figure.rate !== undefined) amount = `${Math.round(size / 100)} points`;
  else if (figure.amount !== undefined) amount = formatINR(size);
  else amount = String(size);
  return { direction: change.direction, text: `${change.direction} ${amount} vs ${against}` };
}

/** The key numbers, two to a row on phones; each opens its list. */
export function KeyNumbers({ tile, filters }) {
  if (!tile) return null;
  const ids = Object.keys(METRICS).filter((id) => METRICS[id].tile === 'key_numbers' && tile.metrics?.[id]);
  const note = notFilteredText(tile.notFilteredBy);
  return (
    <section aria-label="Key numbers" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Key numbers</h2>
      {tile.error ? (
        <Text c="var(--vs-muted)">{UNAVAILABLE}</Text>
      ) : (
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="sm">
          {ids.map((id) => (
            <StatTile
              key={id}
              label={METRICS[id].label}
              value={figureText(id, tile.metrics[id])}
              change={changeText(id, tile.metrics[id], filters.preset)}
              to={`/home/${id}?${filterQuery(filters)}`}
            />
          ))}
        </SimpleGrid>
      )}
      {note && (
        <Text size="xs" c="var(--vs-muted)" mt={6}>
          {note}
        </Text>
      )}
    </section>
  );
}
