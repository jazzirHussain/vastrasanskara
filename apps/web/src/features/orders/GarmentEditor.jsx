import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { References } from './new/GarmentsStep.jsx';
import { useGarmentUpdate } from './ordersApi.js';

const keysOf = (refs) => refs.map((r) => r.key ?? r);

function fromGarment(g) {
  return {
    description: g.description,
    fabric: g.fabric ?? '',
    designNotes: g.designNotes ?? '',
    price: g.agreedPrice === undefined ? '' : g.agreedPrice / 100,
    dueDate: g.dueDate ?? '',
    referenceKeys: g.referenceKeys,
  };
}

// The API's fields from the form's; money in paise, an empty due date follows the pickup date.
function toPatch(draft) {
  return {
    description: draft.description.trim(),
    fabric: draft.fabric.trim(),
    designNotes: draft.designNotes.trim(),
    agreedPrice: Math.round(Number(draft.price) * 100),
    dueDate: draft.dueDate || null,
    referenceKeys: keysOf(draft.referenceKeys),
  };
}

/**
 * Edits a garment after the order is taken, sending only the changed fields. Without
 * orders.write only design notes and reference photos can change, as on the server.
 */
export function GarmentEditor({ order, garment, opened, onClose }) {
  const { can } = useAuth();
  const full = can('orders.write');
  const showPrice = full && garment.agreedPrice !== undefined;
  const update = useGarmentUpdate(order.id, garment.id);
  const [draft, setDraft] = useState(() => fromGarment(garment));
  const set = (changes) => {
    update.reset();
    setDraft((d) => ({ ...d, ...changes }));
  };

  const editable = full
    ? [
        'description',
        'fabric',
        'designNotes',
        'dueDate',
        'referenceKeys',
        ...(showPrice ? ['agreedPrice'] : []),
      ]
    : ['designNotes', 'referenceKeys'];
  const before = toPatch(fromGarment(garment));
  const after = toPatch(draft);
  const changes = Object.fromEntries(
    editable
      .filter((f) => JSON.stringify(after[f]) !== JSON.stringify(before[f]))
      .map((f) => [f, after[f]]),
  );
  const invalid =
    (full && !after.description) || (showPrice && (draft.price === '' || draft.price < 0));

  function save() {
    update.mutate({ version: garment.version, ...changes }, { onSuccess: onClose });
  }

  return (
    <Modal opened={opened} onClose={onClose} title={`Edit ${garment.description}`} size="lg">
      <Stack gap="sm">
        {full && (
          <>
            <TextInput
              label="Description"
              value={draft.description}
              onChange={(e) => set({ description: e.currentTarget.value })}
            />
            <SimpleGrid cols={{ base: 1, xs: showPrice ? 3 : 2 }}>
              {showPrice && (
                <NumberInput
                  label="Agreed price (₹)"
                  min={0}
                  thousandSeparator=","
                  thousandsGroupStyle="lakh"
                  decimalScale={2}
                  value={draft.price}
                  onChange={(v) => set({ price: v })}
                />
              )}
              <TextInput
                label="Fabric"
                value={draft.fabric}
                onChange={(e) => set({ fabric: e.currentTarget.value })}
              />
              <TextInput
                label="Own due date"
                description="Empty follows the pickup date"
                type="date"
                max={order.pickupDate}
                value={draft.dueDate}
                onChange={(e) => set({ dueDate: e.currentTarget.value })}
              />
            </SimpleGrid>
          </>
        )}
        <Textarea
          label="Design notes"
          autosize
          minRows={2}
          value={draft.designNotes}
          onChange={(e) => set({ designNotes: e.currentTarget.value })}
        />
        <References garment={draft} onChange={(referenceKeys) => set({ referenceKeys })} />
        {update.error?.code === 'CONFLICT' && (
          <Alert color="haldi">
            <Group justify="space-between">
              <Text size="sm">Someone else changed this garment. Reload to see their changes.</Text>
              <Button
                size="xs"
                variant="white"
                color="haldi"
                onClick={() => {
                  update.reloadOrder();
                  onClose();
                }}
              >
                Reload
              </Button>
            </Group>
          </Alert>
        )}
        {update.error && update.error.code !== 'CONFLICT' && (
          <Alert color="red">{update.error.message}</Alert>
        )}
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={save}
            disabled={Object.keys(changes).length === 0 || invalid}
            loading={update.isPending}
          >
            Save garment
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
