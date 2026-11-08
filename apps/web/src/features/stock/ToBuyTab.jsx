import { useState } from 'react';
import { Alert, Button, Chip, Group, Loader, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { formatINR } from '@vs/shared/money.js';
import { useAuth } from '../../auth/AuthContext.js';
import { shortDate } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { ReasonDialog } from '../../components/ReasonDialog.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { useVendors } from '../workshop/workshopApi.js';
import { showQty } from './qty.js';
import { ReceiveDialog } from './ReceiveDialog.jsx';
import { RequestModal } from './RequestModal.jsx';
import { useCancelRequest, useMarkOrdered, useRequests } from './stockApi.js';
import { UndoReceiptDialog } from './UndoReceiptDialog.jsx';

const REASONS = { low_stock: 'Running low', manual: 'Added by hand' };

/** "Red silk — 6 m (1 roll)": the quantity in usage units, and in purchase units when they differ. */
export function requestTitle({ stockItem: it, quantity }) {
  const usage = `${it.name} — ${showQty(quantity, it.usageUnit)}`;
  if (it.purchaseUnit.toLowerCase() === it.usageUnit.toLowerCase()) return usage;
  return `${usage} (${showQty(Math.round((quantity * 1000) / it.factor), it.purchaseUnit)})`;
}

/** "For VS/ORD/2627/0012-01, -02": garments of the same order after the first show only their suffix. */
function forGarments(needs) {
  let prefix = null;
  const parts = needs.map(({ garmentNo }) => {
    const cut = garmentNo.lastIndexOf('-');
    const own = cut > 0 ? garmentNo.slice(0, cut) : garmentNo;
    if (own === prefix) return garmentNo.slice(cut);
    prefix = own;
    return garmentNo;
  });
  return `For ${parts.join(', ')}`;
}

const whyText = (r) => (r.reason === 'shortfall' && r.needs.length ? forGarments(r.needs) : REASONS[r.reason] ?? 'For an order');
const statusText = (r) => (r.status === 'ordered' ? (r.vendor ? `Ordered from ${r.vendor.name}` : 'Ordered') : 'To order');

function OrderedDialog({ request, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const vendors = useVendors({ active: true });
  const mark = useMarkOrdered(request.id);
  const [vendorId, setVendorId] = useState(null);
  const [note, setNote] = useState(request.note ?? '');
  const save = async () => {
    try {
      await mark.mutateAsync({ version: request.version, vendorId, note: note.trim() });
      onClose();
    } catch {
      // Shown below.
    }
  };
  return (
    <Modal opened title={`Mark ordered — ${request.stockItem.name}`} centered={!phone} fullScreen={phone} onClose={mark.isPending ? () => {} : onClose}>
      <Stack gap="md">
        <Select
          label="Ordered from (optional)"
          searchable
          clearable
          data={(vendors.data?.items ?? []).map((v) => ({ value: v.id, label: v.name }))}
          value={vendorId}
          onChange={setVendorId}
        />
        <Textarea label="Note (optional)" autosize minRows={1} maxLength={300} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        {mark.error && <Alert color="red">{mark.error.message}</Alert>}
        <Group justify="flex-end" grow={phone}>
          <Button variant="default" size="md" onClick={onClose} disabled={mark.isPending}>
            Go back
          </Button>
          <Button size="md" loading={mark.isPending} onClick={save}>
            Mark ordered
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CancelDialog({ request, onClose }) {
  const cancel = useCancelRequest(request.id);
  return (
    <ReasonDialog
      title="Take off the list"
      reasonLabel="Why?"
      confirmLabel="Yes, take it off"
      pending={cancel.isPending}
      error={cancel.error?.message}
      onClose={onClose}
      onConfirm={async (reason) => {
        try {
          await cancel.mutateAsync({ version: request.version, reason });
          onClose();
        } catch {
          // Shown in the dialog.
        }
      }}
    >
      {`${requestTitle(request)} comes off the "To buy" list.`}
    </ReasonDialog>
  );
}

function OpenRow({ request: r, canWrite, onAction }) {
  return (
    <div data-request={r.id} style={{ padding: '10px 12px', borderBottom: '1px solid var(--vs-rule)' }}>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <div style={{ minWidth: 0 }}>
          <Text fw={600}>{requestTitle(r)}</Text>
          <Text size="sm" c="var(--vs-muted)">
            {whyText(r)}
          </Text>
          <Text size="sm" fw={600} c={r.status === 'ordered' ? 'indigo.8' : 'haldi.9'}>
            {statusText(r)}
          </Text>
          {r.note && <Text size="sm">{r.note}</Text>}
        </div>
        {canWrite && (
          <Group gap="xs">
            {r.status === 'requested' && (
              <Button variant="default" size="md" onClick={() => onAction('order', r)}>
                Mark ordered
              </Button>
            )}
            <Button size="md" onClick={() => onAction('receive', r)}>
              Receive delivery
            </Button>
            <Button variant="subtle" color="kumkum" size="md" onClick={() => onAction('cancel', r)}>
              Cancel
            </Button>
          </Group>
        )}
      </Group>
    </div>
  );
}

/** The latest delivery of each item (only it can be undone): by receipt date, the list's order breaking ties. */
function latestByItem(rows) {
  const latest = new Map();
  for (const r of rows) {
    const id = r.stockItem.id;
    const kept = latest.get(id);
    if (!kept || (r.receipt?.date ?? '') > (kept.receipt?.date ?? '')) latest.set(id, r);
  }
  return new Set([...latest.values()].map((r) => r.id));
}

function ReceivedRow({ request: r, canUndo, onAction }) {
  return (
    <div data-request={r.id} style={{ padding: '10px 12px', borderBottom: '1px solid var(--vs-rule)' }}>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <div style={{ minWidth: 0 }}>
          <Text fw={600}>{`${r.stockItem.name} — ${showQty(r.receipt?.quantity ?? r.quantity, r.stockItem.usageUnit)}`}</Text>
          <Text size="sm" c="var(--vs-muted)">
            {[r.receipt?.date && `Received ${shortDate(r.receipt.date)}`, r.receipt && Number.isSafeInteger(r.receipt.value) && formatINR(r.receipt.value)].filter(Boolean).join(' · ')}
          </Text>
        </div>
        {canUndo && (
          <Button variant="default" color="kumkum" size="md" onClick={() => onAction('undo', r)}>
            Undo delivery
          </Button>
        )}
      </Group>
    </div>
  );
}

/** "To buy": what to order and what has arrived. `status` is 'open' or 'received'. */
export function ToBuyTab({ status, onStatus }) {
  const { can } = useAuth();
  const canWrite = can('stock.write');
  const query = useRequests(status);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const [action, setAction] = useState(null);
  const onAction = (kind, request) => setAction({ kind, request });
  const close = () => setAction(null);
  const undoable = status === 'received' ? latestByItem(rows) : new Set();

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Chip.Group multiple={false} value={status} onChange={onStatus}>
          <Group gap="xs">
            <Chip value="open" type="radio" variant="outline" size="md">
              To buy
            </Chip>
            <Chip value="received" type="radio" variant="outline" size="md">
              Received
            </Chip>
          </Group>
        </Chip.Group>
        {canWrite && status === 'open' && (
          <Button variant="default" size="md" onClick={() => setAction({ kind: 'add' })}>
            Add to list
          </Button>
        )}
      </Group>
      {query.isPending && <Loader />}
      {query.error && <Alert color="red">{query.error.message}</Alert>}
      {query.data && rows.length === 0 && (
        <EmptyState title={status === 'open' ? 'Nothing to buy right now.' : 'No deliveries yet.'} body={status === 'open' ? 'Shortfalls on orders and items running low show up here.' : undefined} />
      )}
      {rows.length > 0 && (
        <div className="vs-panel" style={{ overflow: 'hidden' }}>
          {rows.map((r) =>
            status === 'open' ? (
              <OpenRow key={r.id} request={r} canWrite={canWrite} onAction={onAction} />
            ) : (
              <ReceivedRow key={r.id} request={r} canUndo={canWrite && undoable.has(r.id)} onAction={onAction} />
            ),
          )}
        </div>
      )}
      <LoadMore query={query} />
      {action?.kind === 'add' && <RequestModal onClose={close} />}
      {action?.kind === 'order' && <OrderedDialog request={action.request} onClose={close} />}
      {action?.kind === 'cancel' && <CancelDialog request={action.request} onClose={close} />}
      {action?.kind === 'undo' && <UndoReceiptDialog request={action.request} onClose={close} />}
      {action?.kind === 'receive' && <ReceiveDialog item={action.request.stockItem} request={action.request} onClose={close} />}
    </Stack>
  );
}
