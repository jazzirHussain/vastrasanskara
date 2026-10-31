import { Anchor, Group, Stack, Text } from '@mantine/core';
import { formatINR } from '@vs/shared/money.js';
import { Money } from '../../components/Money.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function CategoryRow({ row, share, selected, onPick }) {
  return (
    <button
      type="button"
      className="vs-row"
      onClick={() => onPick(row.category.key)}
      aria-pressed={selected}
      style={{
        display: 'block',
        width: '100%',
        minHeight: 56,
        padding: '10px 12px',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
        background: selected ? '#EEEFF7' : 'transparent',
        border: 0,
        borderBottom: '1px solid var(--vs-rule)',
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text fw={600} style={{ minWidth: 0 }}>
          {row.category.label}
        </Text>
        <Money paise={row.total} style={{ fontWeight: 600 }} />
      </Group>
      <div aria-hidden="true" style={{ height: 8, margin: '6px 0 4px', borderRadius: 4, background: 'var(--vs-rule)', overflow: 'hidden' }}>
        <div data-bar={row.category.key} style={{ width: `${share}%`, height: '100%', background: 'var(--vs-indigo)' }} />
      </div>
      <Text size="sm" c="var(--vs-muted)">
        {plural(row.count, 'expense', 'expenses')}
      </Text>
    </button>
  );
}

/**
 * The month at a glance: what was spent, last month's figure, one bar per category (tap to
 * filter the list), the GST that can be claimed and the GST bills still missing a photo.
 */
export function MonthSummary({ summary, category, onCategory, onNoBill }) {
  const { total, previousMonthTotal, byCategory, gst, missingBill, locked } = summary;
  const claim = gst.itc.cgst + gst.itc.sgst + gst.itc.igst;
  return (
    <section className="vs-panel" aria-label="This month" style={{ padding: 16 }}>
      <Stack gap={4}>
        <Group gap="sm" align="baseline" wrap="wrap">
          <Text className="vs-figures" fw={700} style={{ fontSize: 30, lineHeight: 1.2 }}>{`${formatINR(total)} spent`}</Text>
          {locked && <StatusBadge status="completed" label="Month locked" />}
        </Group>
        <Text size="sm" c="var(--vs-muted)">{`${formatINR(previousMonthTotal)} last month`}</Text>
      </Stack>
      {byCategory.length > 0 && (
        <div style={{ margin: '12px -12px 0' }}>
          {byCategory.map((row) => (
            <CategoryRow
              key={row.category.key}
              row={row}
              share={total > 0 ? (row.total / total) * 100 : 0}
              selected={category === row.category.key}
              onPick={onCategory}
            />
          ))}
        </div>
      )}
      {gst.count > 0 && (
        <Text size="sm" mt="sm">
          {`GST you can claim ${formatINR(claim)} (CGST ${formatINR(gst.itc.cgst)} SGST ${formatINR(gst.itc.sgst)} IGST ${formatINR(gst.itc.igst)})`}
        </Text>
      )}
      {missingBill > 0 && (
        <Anchor component="button" type="button" size="md" mt="xs" onClick={onNoBill} style={{ minHeight: 44 }}>
          {missingBill === 1 ? '1 GST bill has no photo' : `${missingBill} GST bills have no photo`}
        </Anchor>
      )}
    </section>
  );
}
