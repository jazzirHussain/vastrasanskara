import { Link } from 'react-router-dom';
import { Anchor, Group, Paper, Text } from '@mantine/core';
import { UNAVAILABLE, notFilteredText } from '../copy.js';
import { filterQuery } from '../dashboardApi.js';

/** A Home tile: title, a one-line explanation, its content, "See all", and what filters it ignores. */
export function TileCard({ title, explain, tile, metric, filters, children }) {
  const note = notFilteredText(tile?.notFilteredBy);
  return (
    <Paper component="section" aria-label={title} withBorder radius="md" p="md">
      <Group justify="space-between" align="baseline" wrap="nowrap" mb={2}>
        <h3 style={{ fontSize: 17, margin: 0 }}>{title}</h3>
        {metric && !tile?.error && (
          <Anchor component={Link} to={`/home/${metric}?${filterQuery(filters)}`} size="sm" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
            See all
          </Anchor>
        )}
      </Group>
      <Text size="sm" c="var(--vs-muted)" mb="sm">
        {explain}
      </Text>
      {tile?.error ? <Text c="var(--vs-muted)">{UNAVAILABLE}</Text> : children}
      {note && (
        <Text size="xs" c="var(--vs-muted)" mt="sm">
          {note}
        </Text>
      )}
    </Paper>
  );
}

/** Navigates to one bar's list. */
export const barLink = (metric, filters, key) => `/home/${metric}?${filterQuery(filters, { key })}`;
