import { useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import { suggestedOrder, toUsage } from '@vs/shared/stock.js';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { QtyStepper } from './QtyStepper.jsx';
import { showQty } from './qty.js';
import { useCreateRequest, useStockItems } from './stockApi.js';

const sameUnit = (it) => it.purchaseUnit.toLowerCase() === it.usageUnit.toLowerCase();

/** Choosing the item for "Add to list". */
function ItemChoice({ item, onChange }) {
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const list = useStockItems(q ? { q } : {});
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (item && !items.some((it) => it.id === item.id)) items.unshift(item);
  return (
    <Select
      label="Item"
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      data={items.map((it) => ({ value: it.id, label: it.name }))}
      value={item?.id ?? null}
      onChange={(id) => onChange(items.find((it) => it.id === id) ?? null)}
      nothingFoundMessage="No items match"
    />
  );
}

/**
 * Puts an item on the "To buy" list, in whole purchase units: from "Order more" (`item` given,
 * the amount suggested to bring free stock to twice the reorder level) or "Add to list".
 */
export function RequestModal({ item: given = null, reason = 'manual', onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [item, setItem] = useState(given);
  const [units, setUnits] = useState(() => (given ? suggestedOrder(given) : 1000));
  const [note, setNote] = useState('');
  const create = useCreateRequest();

  const save = async () => {
    try {
      await create.mutateAsync({ stockItemId: item.id, quantity: toUsage(units, item.factor), reason, note: note.trim() });
      onClose();
    } catch {
      // Shown below.
    }
  };

  return (
    <Modal opened title={given ? `Order more ${given.name}` : 'Add to the list'} centered={!phone} fullScreen={phone} onClose={create.isPending ? () => {} : onClose}>
      <Stack gap="md">
        {!given && <ItemChoice item={item} onChange={setItem} />}
        {item && (
          <>
            <Text fw={600}>How many to buy?</Text>
            <QtyStepper value={units} onChange={setUnits} step={1000} min={1000} unit={item.purchaseUnit} label="To buy" />
            {!sameUnit(item) && <Text size="sm">{`= ${showQty(toUsage(units, item.factor), item.usageUnit)}`}</Text>}
          </>
        )}
        <Textarea label="Note (optional)" autosize minRows={1} maxLength={300} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        {create.error && <Alert color="red">{create.error.message}</Alert>}
        <Group justify="flex-end" grow={phone}>
          <Button variant="default" size="md" onClick={onClose} disabled={create.isPending}>
            Go back
          </Button>
          <Button size="md" disabled={!item || units <= 0} loading={create.isPending} onClick={save}>
            Add to list
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
