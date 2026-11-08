import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { QtyStepper } from './QtyStepper.jsx';
import { paiseInput, showQty } from './qty.js';
import { STOCK_KEY, useCountStock } from './stockApi.js';

function differenceText(counted, recorded, unit) {
  if (counted === recorded) return 'Same as recorded';
  const diff = showQty(Math.abs(counted - recorded), unit);
  return counted < recorded ? `${diff} less than recorded` : `${diff} more than recorded`;
}

/** "Count stock": staff say what is on the shelf; the server records the difference with the reason. */
export function CountDialog({ item, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const queryClient = useQueryClient();
  const count = useCountStock(item.id);
  const [counted, setCounted] = useState(item.onHand);
  const [reason, setReason] = useState('');
  const [cost, setCost] = useState('');
  const needsCost = item.onHand === 0 && counted > 0;
  const unitCost = needsCost ? paiseInput(cost) : null;
  const ready = Boolean(reason.trim()) && counted !== item.onHand && (!needsCost || unitCost !== null);
  const conflict = count.error?.code === 'CONFLICT';

  const save = async () => {
    try {
      await count.mutateAsync({ counted, expectedOnHand: item.onHand, reason: reason.trim(), ...(needsCost && { unitCost }) });
      onClose();
    } catch (err) {
      // Shown below; on a conflict the item is read again so the next count starts from it.
      if (err.code === 'CONFLICT') queryClient.invalidateQueries({ queryKey: [...STOCK_KEY, 'item', item.id] });
    }
  };

  return (
    <Modal opened title={`Count stock — ${item.name}`} centered={!phone} fullScreen={phone} onClose={count.isPending ? () => {} : onClose}>
      <Stack gap="md">
        <Text fw={600}>How many are on the shelf now?</Text>
        <QtyStepper value={counted} onChange={setCounted} step={item.step} unit={item.usageUnit} label="On the shelf" />
        <Text size="sm" c={counted === item.onHand ? 'var(--vs-muted)' : undefined}>
          {differenceText(counted, item.onHand, item.usageUnit)}
        </Text>
        {needsCost && (
          <TextInput label={`Cost per ${item.usageUnit} (₹)`} inputMode="decimal" value={cost} onChange={(e) => setCost(e.currentTarget.value)} />
        )}
        <Textarea label="Reason" autosize minRows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        {count.error && <Alert color="red">{conflict ? 'Stock changed while you were counting. Count again.' : count.error.message}</Alert>}
        <Group justify="flex-end" grow={phone}>
          <Button variant="default" size="md" onClick={onClose} disabled={count.isPending}>
            Go back
          </Button>
          <Button size="md" disabled={!ready} loading={count.isPending} onClick={save}>
            Save count
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
