import { useState } from 'react';
import { Button, Group, Text } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { StageActionDialog } from '../orders/StageActionDialog.jsx';
import { actionLabel, actionsFor, primaryAction } from '../orders/stageSteps.js';

// One garment at a time, as the API requires.
const SINGLE = new Set(['alteration', 'rejected']);

/** The steps every selected row allows (rows are on active orders). */
function commonActions(rows, can) {
  const [first, ...rest] = rows.map((r) => actionsFor({ status: 'active' }, r.garment, can));
  return first.filter((a) => !SINGLE.has(a) && rest.every((actions) => actions.includes(a)));
}

/**
 * The selected garments and the steps that can be applied to all of them at once. Only
 * garments at the same stage can move together.
 */
export function BulkBar({ selected, onClear }) {
  const { can } = useAuth();
  const [action, setAction] = useState(null);
  const sameStage = new Set(selected.map((r) => r.workingStage)).size === 1;
  const actions = sameStage ? commonActions(selected, can) : [];
  const primary = primaryAction(actions);
  const garments = selected.map((r) => r.garment);
  const label = `${selected.length} garment${selected.length === 1 ? '' : 's'} selected`;

  return (
    <section
      aria-label={label}
      className="vs-panel"
      style={{ position: 'sticky', bottom: 12, zIndex: 5, padding: 12, marginTop: 12, boxShadow: 'var(--mantine-shadow-md)' }}
    >
      <Group justify="space-between" gap="sm">
        <Text fw={600}>{label}</Text>
        <Group gap="xs">
          {!sameStage && (
            <Text size="sm" c="var(--vs-muted)">
              Pick garments at the same stage
            </Text>
          )}
          {sameStage && actions.length === 0 && (
            <Text size="sm" c="var(--vs-muted)">
              No step fits all of them
            </Text>
          )}
          {actions.map((a) => (
            <Button key={a} size="xs" variant={a === primary ? 'filled' : 'default'} onClick={() => setAction(a)}>
              {actionLabel(a, garments[0])}
            </Button>
          ))}
          <Button size="xs" variant="subtle" onClick={onClear}>
            Clear
          </Button>
        </Group>
      </Group>
      {action && <StageActionDialog action={action} garments={garments} onClose={() => setAction(null)} onDone={onClear} />}
    </section>
  );
}
