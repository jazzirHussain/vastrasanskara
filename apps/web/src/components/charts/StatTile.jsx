import { Link } from 'react-router-dom';
import { Paper, Text } from '@mantine/core';
import { IconArrowDownRight, IconArrowRight, IconArrowUpRight } from '@tabler/icons-react';

const ARROWS = { up: IconArrowUpRight, down: IconArrowDownRight, same: IconArrowRight };

/** A key number: label, big value and a change line in words; the whole tile opens its list. */
export function StatTile({ label, value, change, to }) {
  const Arrow = change ? ARROWS[change.direction] : null;
  return (
    <Paper component={Link} to={to} withBorder radius="md" p="sm" aria-label={`${label} ${value}`} style={{ display: 'block', textDecoration: 'none', color: 'inherit', minHeight: 44 }}>
      <Text size="sm" c="var(--vs-muted)">
        {label}
      </Text>
      <Text fw={600} fz={22} className="vs-figures" lh={1.3}>
        {value}
      </Text>
      {change && (
        <Text size="xs" c="var(--vs-muted)" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Arrow size={14} aria-hidden />
          {change.text}
        </Text>
      )}
    </Paper>
  );
}
