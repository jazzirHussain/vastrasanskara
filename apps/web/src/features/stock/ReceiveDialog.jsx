import { useRef, useState } from 'react';
import { Alert, Button, Loader, Modal, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { formatINR } from '@vs/shared/money.js';
import { toUsage } from '@vs/shared/stock.js';
import { todayYmd } from '../../components/DateLabel.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { paiseOf } from '../billing/rupees.js';
import { AmountField } from '../expenses/AmountField.jsx';
import { BillPhotos } from '../expenses/BillPhotos.jsx';
import { emptyExpenseForm, formToBody } from '../expenses/expenseForm.js';
import { GstSection, gstIssues } from '../expenses/GstSection.jsx';
import { ModeButtons } from '../expenses/ModeButtons.jsx';
import { PayeePicker } from '../expenses/PayeePicker.jsx';
import { useBranch } from '../settings/settingsApi.js';
import { QtyStepper } from './QtyStepper.jsx';
import { showQty } from './qty.js';
import { useReceive } from './stockApi.js';

/** Purchase units (milli) of a usage quantity, rounded to the nearest thousandth. */
const purchaseUnits = (usageMilli, factor) => Math.max(1, Math.round((usageMilli * 1000) / factor));

function ReceiveForm({ item, request, branchStateCode, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  // Made when the dialog opens and sent again on every retry: a double tap or a dropped
  // connection never receives the delivery (or saves its expense) twice.
  const [key] = useState(() => crypto.randomUUID());
  const [units, setUnits] = useState(() => (request ? purchaseUnits(request.quantity, item.factor) : 1000));
  const [form, setForm] = useState(() => {
    const start = emptyExpenseForm(todayYmd());
    const vendor = request?.vendor;
    return vendor ? { ...start, payee: { vendorId: vendor.id, name: vendor.name, gstin: null, stateCode: null } } : start;
  });
  const receive = useReceive(request ? { requestId: request.id } : { itemId: item.id });
  const saving = useRef(false);
  const edit = (patch) => setForm((f) => ({ ...f, ...patch }));

  const total = paiseOf(form.amount);
  const uploading = form.photos.some((p) => p.status === 'uploading');
  const failedPhoto = form.photos.some((p) => p.status === 'failed');
  const issues = gstIssues(form, branchStateCode);
  const ready = total !== null && total > 0 && form.payee.name.trim() !== '' && units > 0 && issues.length === 0 && !uploading && !failedPhoto;
  const differentUnit = item.purchaseUnit.toLowerCase() !== item.usageUnit.toLowerCase();

  async function save() {
    if (saving.current) return;
    saving.current = true;
    try {
      const b = formToBody({ ...form, category: 'material_purchase', link: null }, { branchStateCode });
      const body = {
        quantity: toUsage(units, item.factor), date: b.date, total: b.total, mode: b.mode, reference: b.reference, payee: b.payee, gst: b.gst, attachments: b.attachments,
      };
      const { expense } = await receive.mutateAsync({ body, key });
      notifications.show({ color: 'neem', message: `Stock added and expense ${expense.number} saved` });
      onClose();
    } catch {
      // Shown below; the same key goes with the retry.
      saving.current = false;
    }
  }

  return (
    <Modal opened title={`Receive delivery — ${item.name}`} size="lg" centered={!phone} fullScreen={phone} onClose={receive.isPending ? () => {} : onClose}>
      <Stack gap="md">
        <Text fw={600}>How much arrived?</Text>
        <QtyStepper value={units} onChange={setUnits} step={1000} min={1} unit={item.purchaseUnit} label="Arrived" />
        {differentUnit && <Text size="sm">{`= ${showQty(toUsage(units, item.factor), item.usageUnit)}`}</Text>}
        <AmountField label="How much did you pay?" value={form.amount} onChange={(amount) => setForm((f) => ({ ...f, amount, gst: { ...f.gst, edited: f.gst.rateBp === null ? f.gst.edited : null } }))} />
        <PayeePicker
          payee={form.payee}
          onChange={(payee) => setForm((f) => ({ ...f, payee, gst: { ...f.gst, gstin: payee.gstin ?? (f.payee.vendorId ? '' : f.gst.gstin) } }))}
        />
        <ModeButtons mode={form.mode} reference={form.reference} onMode={(mode) => edit({ mode })} onReference={(reference) => edit({ reference })} />
        <BillPhotos photos={form.photos} setPhotos={(change) => setForm((f) => ({ ...f, photos: change(f.photos) }))} />
        <GstSection form={form} setForm={setForm} branchStateCode={branchStateCode} />
        {issues.length > 0 && form.gstOpen && (
          <Alert color="red">
            {issues.map((m) => (
              <div key={m}>{m}</div>
            ))}
          </Alert>
        )}
        {receive.error && <Alert color="red">{receive.error.message}</Alert>}
        <Button size="xl" fullWidth disabled={!ready} loading={receive.isPending} onClick={save}>
          {total ? `Save delivery of ${formatINR(total)}` : 'Save delivery'}
        </Button>
      </Stack>
    </Modal>
  );
}

/**
 * "Receive delivery": the stock and its material expense in one step, on one screen. Against a
 * "to buy" `request`, or straight onto `item` (from the item page).
 */
export function ReceiveDialog({ item, request = null, onClose }) {
  const branch = useBranch();
  if (branch.isPending) return <Loader />;
  if (branch.error) return <Alert color="red">{branch.error.message}</Alert>;
  return <ReceiveForm item={item} request={request} branchStateCode={branch.data.stateCode} onClose={onClose} />;
}
