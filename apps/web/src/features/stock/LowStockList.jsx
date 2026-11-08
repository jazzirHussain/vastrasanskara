import { Button, Group, Text } from '@mantine/core';
import { showQty } from './qty.js';

/** "Running low": items whose free stock is under their reorder level, each with "Order more" for stock staff. */
export function LowStockList({ items, onOrderMore }) {
  if (!items?.length) return null;
  return (
    <section aria-label="Running low" className="vs-panel" style={{ padding: '12px 12px 4px', borderLeft: '4px solid var(--mantine-color-red-7)' }}>
      <Text fw={700} mb={6}>
        Running low
      </Text>
      {items.map((it) => (
        <Group key={it.id} data-low-item={it.id} justify="space-between" wrap="nowrap" gap="sm" style={{ minHeight: 56, borderTop: '1px solid var(--vs-rule)', padding: '6px 0' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <Text fw={600}>
              {it.name}
              {it.colour && (
                <Text span c="var(--vs-muted)" fw={400}>
                  {' '}
                  · {it.colour}
                </Text>
              )}
            </Text>
            <Text size="sm" c="red.8" fw={600} data-alert="true">
              {`${showQty(it.free, it.usageUnit)} free · reorder at ${showQty(it.reorderLevel, it.usageUnit)}`}
            </Text>
          </div>
          {onOrderMore && (
            <Button variant="light" size="md" style={{ flexShrink: 0 }} onClick={() => onOrderMore(it)}>
              Order more
            </Button>
          )}
        </Group>
      ))}
    </section>
  );
}
