import { useState } from 'react';
import { Loader, Stack, Text } from '@mantine/core';
import { QtyStepper } from './QtyStepper.jsx';
import { showQty } from './qty.js';
import { useGarmentsMaterials } from './stockApi.js';

/**
 * The planned materials of the garments, item by item: { stockItemId, name, usageUnit, step,
 * planned: [{ garmentId, quantity }] }, in first-seen order. `uniform` when every garment that has
 * the item plans the same quantity.
 */
export function plannedItems(cards) {
  const items = new Map();
  for (const card of cards) {
    for (const l of card?.lines ?? []) {
      if (l.state !== 'planned') continue;
      if (!items.has(l.stockItemId)) items.set(l.stockItemId, { stockItemId: l.stockItemId, name: l.name, usageUnit: l.usageUnit, step: l.step, planned: [] });
      items.get(l.stockItemId).planned.push({ garmentId: card.garmentId, quantity: l.planned });
    }
  }
  return [...items.values()].map((it) => ({ ...it, uniform: new Set(it.planned.map((p) => p.quantity)).size === 1 }));
}

/**
 * "Materials used" at Materials ready: the planned list pre-filled, a stepper per item. With
 * several garments one stepper sets the quantity for each garment that has the item; an item
 * planned differently across them stays "Materials as planned". `onChange(materialsUsed)` gets
 * only the corrections ({ garmentId, stockItemId, quantity }), [] when nothing changed.
 */
export function MaterialsUsed({ garments, onChange }) {
  const queries = useGarmentsMaterials(garments.map((g) => g.id));
  const [quantities, setQuantities] = useState({});
  if (queries.some((q) => q.isPending)) return <Loader size="sm" />;
  const items = plannedItems(queries.map((q) => q.data));
  if (!items.length) return null;
  const several = garments.length > 1;

  const setQuantity = (item, quantity) => {
    const next = { ...quantities, [item.stockItemId]: quantity };
    setQuantities(next);
    onChange(
      items.flatMap((it) => {
        const q = next[it.stockItemId];
        if (q === undefined || !it.uniform || q === it.planned[0].quantity) return [];
        return it.planned.map((p) => ({ garmentId: p.garmentId, stockItemId: it.stockItemId, quantity: q }));
      }),
    );
  };

  return (
    <div role="group" aria-label="Materials used">
      <Text fw={600} mb={4}>
        Materials used
      </Text>
      <Stack gap={6}>
        {items.map((it) => (
          <div key={it.stockItemId} data-material={it.stockItemId} style={{ borderBottom: '1px solid var(--vs-rule)', paddingBottom: 6 }}>
            <Text fw={600}>{it.name}</Text>
            {it.uniform ? (
              <>
                <QtyStepper value={quantities[it.stockItemId] ?? it.planned[0].quantity} onChange={(q) => setQuantity(it, q)} step={it.step} min={0} unit={it.usageUnit} label={it.name} />
                {several && (
                  <Text size="xs" c="var(--vs-muted)">
                    each garment
                  </Text>
                )}
              </>
            ) : (
              <>
                <Text size="sm">Materials as planned</Text>
                <Text size="xs" c="var(--vs-muted)">
                  {it.planned.map((p) => showQty(p.quantity, it.usageUnit)).join(' · ')}
                </Text>
              </>
            )}
          </div>
        ))}
      </Stack>
    </div>
  );
}
