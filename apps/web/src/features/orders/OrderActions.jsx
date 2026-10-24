import { useState } from 'react';
import { Alert, Button, Group, Modal, NativeSelect, NumberInput, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { STAGES } from '@vs/shared/stages.js';
import { useAuth } from '../../auth/AuthContext.js';
import { todayYmd } from '../../components/DateLabel.jsx';
import { furthestStage, isOpen, refundPercentFor } from './orderStatus.js';

const stageLabel = (key) => STAGES.find((s) => s.key === key)?.label ?? key;

function ReasonForm({ label, confirm, color, onSubmit, mutation, children }) {
  const [reason, setReason] = useState('');
  return (
    <Stack>
      {children}
      <Textarea label="Reason" autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} data-autofocus />
      {mutation.error && mutation.error.code !== 'CONFLICT' && <Alert color="red">{mutation.error.message}</Alert>}
      <Group justify="flex-end">
        <Button color={color} disabled={!reason.trim()} loading={mutation.isPending} onClick={() => onSubmit(reason.trim())}>
          {confirm ?? label}
        </Button>
      </Group>
    </Stack>
  );
}

function PickupForm({ order, mutation, onSubmit }) {
  const [date, setDate] = useState(order.pickupDate);
  return (
    <Stack>
      <Text size="sm" c="var(--vs-muted)">
        Garments that follow the pickup date are re-planned. The original date is kept.
      </Text>
      <TextInput label="New pickup date" type="date" min={todayYmd()} value={date} onChange={(e) => setDate(e.currentTarget.value)} />
      {mutation.error && mutation.error.code !== 'CONFLICT' && <Alert color="red">{mutation.error.message}</Alert>}
      <Group justify="flex-end">
        <Button disabled={!date || date === order.pickupDate} loading={mutation.isPending} onClick={() => onSubmit(date)}>
          Move pickup
        </Button>
      </Group>
    </Stack>
  );
}

function AddGarmentForm({ garmentTypes, mutation, onSubmit }) {
  const [g, setG] = useState({ type: garmentTypes[0]?.key ?? 'other', description: '', price: '', quantity: 1 });
  const [key] = useState(() => crypto.randomUUID());
  const ready = g.description.trim() && g.price !== '' && g.quantity >= 1;
  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        <NativeSelect label="Garment type" data={garmentTypes.map((t) => ({ value: t.key, label: t.label }))} value={g.type} onChange={(e) => setG({ ...g, type: e.currentTarget.value })} />
        <TextInput label="Description" value={g.description} onChange={(e) => setG({ ...g, description: e.currentTarget.value })} />
        <NumberInput label="Price per piece (₹)" min={0} thousandSeparator="," thousandsGroupStyle="lakh" value={g.price} onChange={(price) => setG({ ...g, price })} />
        <NumberInput label="Identical pieces" min={1} max={200} allowDecimal={false} value={g.quantity} onChange={(q) => setG({ ...g, quantity: Number(q) || '' })} />
      </SimpleGrid>
      {mutation.error && mutation.error.code !== 'CONFLICT' && <Alert color="red">{mutation.error.message}</Alert>}
      <Group justify="flex-end">
        <Button
          disabled={!ready}
          loading={mutation.isPending}
          onClick={() =>
            onSubmit(
              { garments: [{ type: g.type, description: g.description.trim(), agreedPrice: Math.round(Number(g.price) * 100), quantity: g.quantity }] },
              key,
            )
          }
        >
          Add garment
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * Changes to the order, each behind its own small dialog: move the pickup date, put on hold or
 * resume, add a garment, cancel. Shown only to staff who may change orders.
 */
export function OrderActions({ order, settings, mutation }) {
  const { can } = useAuth();
  const [dialog, setDialog] = useState(null);
  if (!can('orders.write') || !isOpen(order)) return null;

  const close = () => {
    setDialog(null);
    mutation.reset();
  };
  const change = (request) =>
    mutation.mutate(request, {
      onSuccess: () => setDialog(null),
      onError: (err) => {
        if (err.code === 'CONFLICT') setDialog(null);
      },
    });
  const version = order.version;
  const reached = furthestStage(order.garments);
  const refund = refundPercentFor(settings?.cancellationRefundSchedule ?? [], reached);

  return (
    <>
      <Group gap="xs" wrap="wrap">
        <Button variant="default" onClick={() => setDialog('pickup')}>
          Change pickup date
        </Button>
        {order.status === 'active' ? (
          <Button variant="default" onClick={() => setDialog('hold')}>
            Put on hold
          </Button>
        ) : (
          <Button variant="default" loading={mutation.isPending} onClick={() => change({ path: '/resume', body: { version } })}>
            Resume
          </Button>
        )}
        <Button variant="default" onClick={() => setDialog('add')}>
          Add garment
        </Button>
        <Button variant="subtle" color="kumkum" onClick={() => setDialog('cancel')}>
          Cancel order
        </Button>
      </Group>

      <Modal opened={dialog === 'pickup'} onClose={close} title="Change pickup date">
        <PickupForm order={order} mutation={mutation} onSubmit={(pickupDate) => change({ method: 'PATCH', body: { version, pickupDate } })} />
      </Modal>
      <Modal opened={dialog === 'hold'} onClose={close} title="Put on hold">
        <ReasonForm label="Put on hold" mutation={mutation} onSubmit={(reason) => change({ path: '/hold', body: { version, reason } })}>
          <Text size="sm" c="var(--vs-muted)">
            Late warnings pause while the order is on hold.
          </Text>
        </ReasonForm>
      </Modal>
      <Modal opened={dialog === 'add'} onClose={close} title="Add garment" size="lg">
        {dialog === 'add' && (
          <AddGarmentForm
            garmentTypes={settings?.garmentTypes ?? []}
            mutation={mutation}
            onSubmit={(body, key) => change({ path: '/garments', body, key })}
          />
        )}
      </Modal>
      <Modal opened={dialog === 'cancel'} onClose={close} title="Cancel order">
        <ReasonForm label="Cancel order" color="kumkum" mutation={mutation} onSubmit={(reason) => change({ path: '/cancel', body: { version, reason } })}>
          <Text size="sm">
            {refund > 0
              ? `${refund}% of the advance is refunded: the furthest stage reached is ${stageLabel(reached)}.`
              : `No refund under the cancellation schedule: the furthest stage reached is ${stageLabel(reached)}.`}
          </Text>
        </ReasonForm>
      </Modal>
    </>
  );
}
