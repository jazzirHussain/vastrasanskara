import { useState } from 'react';
import { Anchor, Button, Group, Loader, Paper, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useOrder, useOrders } from '../orders/ordersApi.js';

function Choices({ orderId, onPick }) {
  const { data: order, isPending } = useOrder(orderId);
  if (isPending) return <Loader size="sm" />;
  if (!order) return null;
  const batches = new Map();
  for (const g of order.garments) {
    if (g.batchId) batches.set(g.batchId, (batches.get(g.batchId) ?? 0) + 1);
  }
  const pick = (kind, id, what) => onPick({ kind, id, label: `${order.orderNo} · ${what}` });
  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">{`${order.orderNo} · ${order.customer.name}`}</Text>
      <Button variant="default" size="md" fullWidth onClick={() => pick('order', order.id, 'Whole order')}>
        Whole order
      </Button>
      {order.garments.map((g) => (
        <Button key={g.id} variant="default" size="md" fullWidth onClick={() => pick('garment', g.id, g.description || g.garmentNo)}>
          {`${g.description || g.type} (${g.garmentNo})`}
        </Button>
      ))}
      {[...batches].filter(([, count]) => count > 1).map(([batchId, count]) => (
        <Button key={batchId} variant="default" size="md" fullWidth onClick={() => pick('batch', batchId, `Batch of ${count} garments`)}>
          {`Batch of ${count} garments`}
        </Button>
      ))}
    </Stack>
  );
}

/** "Link to an order (optional)": folded; search an order, then choose the whole order, one garment or a batch. */
export function LinkPicker({ link, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [order, setOrder] = useState(null);
  const [debounced] = useDebouncedValue(q.trim(), 250);
  const search = useOrders({ q: debounced }, { enabled: open && !order && debounced.length >= 2 });
  const found = search.data?.pages.flatMap((p) => p.items) ?? [];

  if (link) {
    return (
      <Paper withBorder p="sm" radius="md">
        <Group justify="space-between" wrap="nowrap">
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" c="dimmed">
              Linked to
            </Text>
            <Text fw={600}>{link.label || 'An order'}</Text>
          </Stack>
          <Button variant="subtle" size="md" onClick={() => onChange(null)}>
            Remove
          </Button>
        </Group>
      </Paper>
    );
  }
  if (!open) {
    return (
      <Anchor component="button" type="button" size="md" onClick={() => setOpen(true)} style={{ alignSelf: 'flex-start' }}>
        Link to an order (optional)
      </Anchor>
    );
  }
  return (
    <Stack gap="sm">
      {order ? (
        <>
          <Choices
            orderId={order.id}
            onPick={(next) => {
              onChange(next);
              setOrder(null);
              setQ('');
              setOpen(false);
            }}
          />
          <Anchor component="button" type="button" size="sm" onClick={() => setOrder(null)} style={{ alignSelf: 'flex-start' }}>
            Pick another order
          </Anchor>
        </>
      ) : (
        <>
          <TextInput label="Find the order" size="md" placeholder="Order number or customer name" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
          {search.isFetching && <Loader size="sm" />}
          {found.map((o) => (
            <Button key={o.id} variant="default" size="md" fullWidth justify="flex-start" onClick={() => setOrder(o)}>
              {`${o.orderNo} · ${o.customer.name}`}
            </Button>
          ))}
          <Anchor component="button" type="button" size="sm" onClick={() => setOpen(false)} style={{ alignSelf: 'flex-start' }}>
            Cancel
          </Anchor>
        </>
      )}
    </Stack>
  );
}
