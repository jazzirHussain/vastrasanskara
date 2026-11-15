import { useState } from 'react';
import { Button, Group, Table, Text } from '@mantine/core';
import './chartTokens.css';

const HEIGHT = 140;
const BAR = 12;
const GAP = 2;
const GROUP_GAP = 14;
const MIN_BAR = 2;
const COLOURS = ['var(--vs-chart-1)', 'var(--vs-chart-2)'];

/** A bar with a 4 px rounded top standing on the baseline. */
function barPath(x, y, w, h) {
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/**
 * Two series side by side per group (e.g. billed against collected by month): one value axis
 * with 3 gridlines, a legend above, the last group labelled, a tap shows a group's values, and
 * "Show as table" gives the same numbers as a table.
 */
export function BarPair({ title, data, series, format = String }) {
  const [table, setTable] = useState(false);
  const [picked, setPicked] = useState(null);
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => d[s.key] ?? 0)));
  const groupWidth = series.length * BAR + (series.length - 1) * GAP;
  const width = Math.max(1, data.length * (groupWidth + GROUP_GAP));
  const scale = (v) => Math.max(MIN_BAR, Math.round(((v ?? 0) / max) * (HEIGHT - 4)));
  const shown = picked === null ? null : data[picked];

  return (
    <div>
      <Group justify="space-between" align="center" mb={6} wrap="nowrap">
        <ul aria-label="Legend" style={{ display: 'flex', gap: 16, listStyle: 'none', margin: 0, padding: 0 }}>
          {series.map((s, i) => (
            <li key={s.key}>
              <span className="vs-chart-swatch" style={{ background: COLOURS[i] }} aria-hidden />
              <Text span size="sm">
                {s.name}
              </Text>
            </li>
          ))}
        </ul>
        <Button variant="subtle" size="sm" style={{ minHeight: 44 }} onClick={() => setTable((t) => !t)}>
          {table ? 'Show as chart' : 'Show as table'}
        </Button>
      </Group>
      {table ? (
        <Table aria-label={title} withRowBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Month</Table.Th>
              {series.map((s) => (
                <Table.Th key={s.key} scope="col">
                  {s.name}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.map((d) => (
              <Table.Tr key={d.label}>
                <Table.Td>{d.label}</Table.Td>
                {series.map((s) => (
                  <Table.Td key={s.key} className="vs-figures">
                    {format(d[s.key] ?? 0)}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : (
        <>
          <svg role="img" aria-label={title} viewBox={`0 0 ${width} ${HEIGHT + 2}`} width="100%" height={HEIGHT + 2} preserveAspectRatio="none">
            {[0.5, 1].map((f) => (
              <line key={f} x1={0} x2={width} y1={HEIGHT - f * (HEIGHT - 4)} y2={HEIGHT - f * (HEIGHT - 4)} stroke="var(--vs-chart-grid)" strokeWidth={1} />
            ))}
            <line x1={0} x2={width} y1={HEIGHT} y2={HEIGHT} stroke="var(--vs-chart-axis)" strokeWidth={1} />
            {data.map((d, gi) => {
              const x0 = gi * (groupWidth + GROUP_GAP) + GROUP_GAP / 2;
              return (
                <g key={d.label}>
                  {series.map((s, si) => {
                    const h = scale(d[s.key]);
                    const x = x0 + si * (BAR + GAP);
                    return <path key={s.key} data-bar="" data-height={h} data-width={BAR} d={barPath(x, HEIGHT - h, BAR, h)} fill={COLOURS[si]} />;
                  })}
                </g>
              );
            })}
          </svg>
          {/* Text sits outside the stretched SVG so it never distorts; only the last month is labelled. */}
          <Text size="xs" c="var(--vs-chart-axis)" ta="right">
            {data.at(-1)?.label}
          </Text>
          <Group gap={4} wrap="wrap" mt={4}>
            {data.map((d, gi) => (
              <Button
                key={d.label}
                variant={picked === gi ? 'light' : 'subtle'}
                size="xs"
                style={{ minHeight: 44, minWidth: 44 }}
                aria-label={`Show ${d.label}`}
                aria-pressed={picked === gi}
                onClick={() => setPicked(picked === gi ? null : gi)}
              >
                {d.label.slice(0, 3)}
              </Button>
            ))}
          </Group>
          <Text role="status" size="sm" mt={4} c="var(--vs-muted)" className="vs-figures">
            {shown ? [shown.label, ...series.map((s) => `${s.name} ${format(shown[s.key] ?? 0)}`)].join(' · ') : ''}
          </Text>
        </>
      )}
    </div>
  );
}
