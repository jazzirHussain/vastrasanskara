import { useState } from 'react';
import { Alert, Anchor, Button, Modal, NumberInput, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { istDate } from '@vs/shared/fy.js';
import { formatINR, rupeesToPaise } from '@vs/shared/money.js';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { paymentErrorMessage } from '../../lib/errorMessages.js';
import { useRecordPayment } from './billingApi.js';
import { PdfButtons } from './PdfButtons.jsx';

const MODES = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'bank_transfer', label: 'Bank transfer' },
];
const REFERENCE_LABEL = {
  upi: 'UPI or card reference (optional)',
  card: 'UPI or card reference (optional)',
  bank_transfer: 'Bank reference (optional)',
};

/** Paise as the plain rupee text of an input ("2000", "2000.5"); empty for nothing. */
function rupeeText(paise) {
  if (!paise || paise <= 0) return '';
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return rest ? `${rupees}.${String(rest).padStart(2, '0').replace(/0$/, '')}` : String(rupees);
}

/** The amount typed, in paise; null when empty or not above zero. */
function paiseOf(value) {
  if (value === '' || value === null || value === undefined) return null;
  try {
    const paise = rupeesToPaise(value);
    return paise > 0 ? paise : null;
  } catch {
    return null;
  }
}

/**
 * Takes a payment from `customer` ({ id, name }): for a bill (`invoice`), for an order's bills
 * (`order`; the server pays the oldest bill first), or as an advance (`order` with nothing
 * billed). `defaultAmount` is what is due; `billBalance` is how much of a payment would pay
 * bills, so anything above it is said to be kept as advance before saving.
 *
 * Mounted once per opening: the Idempotency-Key is made here and sent again on every retry, so a
 * dropped connection followed by "Try again" never records the payment twice.
 */
export function TakePaymentDialog({ customer, order = null, invoice = null, defaultAmount = 0, billBalance = 0, onDone }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [key] = useState(() => crypto.randomUUID());
  const record = useRecordPayment();
  const [amount, setAmount] = useState(() => rupeeText(defaultAmount));
  const [mode, setMode] = useState('cash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [earlier, setEarlier] = useState(false);
  const [receivedOn, setReceivedOn] = useState('');

  const paise = paiseOf(amount);
  const receipt = record.data;
  const kept = paise !== null && billBalance > 0 && paise > billBalance ? paise - billBalance : 0;
  const networkDown = record.error?.code === 'NETWORK_ERROR';

  function save() {
    record.mutate({
      key,
      body: {
        customerId: customer.id,
        orderId: invoice ? null : (order?.id ?? null),
        invoiceId: invoice?.id ?? null,
        amount: paise,
        mode,
        reference: mode === 'cash' ? '' : reference.trim(),
        receivedOn: earlier && receivedOn ? receivedOn : null,
        note: note.trim(),
      },
    });
  }

  return (
    <Modal
      opened
      onClose={onDone}
      title={receipt ? 'Payment saved' : `Take payment from ${customer.name}`}
      centered={!phone}
      fullScreen={phone}
      closeOnClickOutside={!record.isPending && !receipt}
      closeOnEscape={!record.isPending}
    >
      {receipt ? (
        <Stack>
          <Text fw={700} style={{ fontSize: 20 }}>
            Receipt {receipt.number} saved
          </Text>
          {receipt.receiptVoucher && (
            <Text size="sm">A receipt voucher {receipt.receiptVoucher.number} with GST on the advance was also made.</Text>
          )}
          <PdfButtons docId={receipt.id} number={receipt.number} kind="Receipt" />
          <Button size="md" fullWidth={phone} onClick={onDone} data-autofocus>
            Done
          </Button>
        </Stack>
      ) : (
        <Stack gap="md">
          <NumberInput
            label="Amount (₹)"
            size="md"
            inputMode="decimal"
            min={0}
            decimalScale={2}
            allowNegative={false}
            hideControls
            thousandSeparator=""
            value={amount}
            onChange={(v) => setAmount(v === '' ? '' : String(v))}
            data-autofocus
          />

          <div role="group" aria-label="How did they pay?">
            <Text size="sm" fw={500} mb={6}>
              How did they pay?
            </Text>
            <SimpleGrid cols={2} spacing="sm">
              {MODES.map((m) => (
                <Button
                  key={m.value}
                  size="lg"
                  variant={mode === m.value ? 'filled' : 'default'}
                  aria-pressed={mode === m.value}
                  onClick={() => setMode(m.value)}
                >
                  {m.label}
                </Button>
              ))}
            </SimpleGrid>
          </div>

          {mode !== 'cash' && (
            <TextInput label={REFERENCE_LABEL[mode]} size="md" maxLength={100} value={reference} onChange={(e) => setReference(e.currentTarget.value)} />
          )}
          <TextInput label="Note (optional)" size="md" maxLength={300} value={note} onChange={(e) => setNote(e.currentTarget.value)} />

          {earlier ? (
            <TextInput
              label="Date received"
              type="date"
              size="md"
              max={istDate(new Date())}
              value={receivedOn}
              onChange={(e) => setReceivedOn(e.currentTarget.value)}
              description="The receipt is dated today; this day is noted on it."
            />
          ) : (
            <Anchor component="button" type="button" size="sm" onClick={() => setEarlier(true)} style={{ alignSelf: 'flex-start' }}>
              Paid on an earlier day?
            </Anchor>
          )}

          {kept > 0 && (
            <Alert color="indigo">
              {formatINR(billBalance)} will pay the bill, {formatINR(kept)} will be kept as advance.
            </Alert>
          )}
          {record.error && <Alert color="red">{paymentErrorMessage(record.error)}</Alert>}

          <Button size="lg" fullWidth loading={record.isPending} disabled={paise === null} onClick={save}>
            {networkDown ? 'Try again' : paise === null ? 'Enter the amount' : `Save payment of ${formatINR(paise)}`}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
