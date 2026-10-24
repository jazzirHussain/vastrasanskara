import { Stack, Text } from '@mantine/core';
import { istDate } from '@vs/shared/fy.js';
import { shortDate } from '../../components/DateLabel.jsx';

/** Every set taken, grouped by garment type, newest first; the newest set of each type leads. */
export function MeasurementHistory({ items, garmentTypes }) {
  const labelOf = (key) => garmentTypes.find((t) => t.key === key)?.label ?? key;
  const groups = Map.groupBy(items, (m) => m.garmentType);

  return (
    <Stack gap="md">
      {[...groups.entries()].map(([type, sets]) => (
        <section key={type} aria-label={`${labelOf(type)} measurements`}>
          <Text fw={600} mb={6}>
            {labelOf(type)}
          </Text>
          <Stack gap={8}>
            {sets.map((m, i) => (
              <div
                key={m.id}
                className="vs-panel"
                style={{ padding: '10px 14px', opacity: i === 0 ? 1 : 0.72, borderStyle: i === 0 ? 'solid' : 'dashed' }}
              >
                <Text size="xs" c="var(--vs-muted)" mb={6}>
                  Taken {shortDate(istDate(new Date(m.takenAt)))} by {m.takenBy.name}
                  {i === 0 && sets.length > 1 ? ' (latest)' : ''}
                </Text>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
                  {m.values.map((v) => (
                    <span key={v.name} style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--vs-muted)' }}>{v.name}</span>{' '}
                      <span className="vs-figures" style={{ fontWeight: 600 }}>
                        {v.value}
                        {v.unit === 'in' ? '″' : ' cm'}
                      </span>
                    </span>
                  ))}
                </div>
                {m.notes && (
                  <Text size="sm" mt={6}>
                    {m.notes}
                  </Text>
                )}
              </div>
            ))}
          </Stack>
        </section>
      ))}
    </Stack>
  );
}
