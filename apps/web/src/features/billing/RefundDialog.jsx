import { useState } from 'react';
import { Alert, Button, Modal, NumberInput, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { formatINR } from '@vs/shared/money.js';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { correctionErrorMessage, messageFor } from '../../lib/errorMessages.js';
import { useIssueRefund } from './billingApi.js';
import { PdfButtons } from './PdfButtons.jsx';
import { MODE_LABELS, MODES } from './billStatus.js';
import { paiseOf, rupeeText } from './rupees.js';

/**
 * Gives money back from the advance held for `customer` ({ id, name }) with no order, or for one
 * `order` ({ id }). `held` is the most that can go back; `defaultAmount` pre-fills the amount (the
 * refund a cancelled order's schedule suggests). Owner only.
 *
 * Mounted once per opening: the Idempotency-Key is made here and sent again on every retry.
 */
export function RefundDialog({ customer, order = null, held, defaultAmount = 0, onDone }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [key] = useState(() => crypto.randomUUID());
  const refund = useIssueRefund();
  const [amount, setAmount] = useState(() => rupeeText(Math.min(defaultAmount, held)));
  const [mode, setMode] = useState('cash');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');

  const paise = paiseOf(amount);
  const tooMuch = paise !== null && paise > held;
  const reasonText = reason.trim();
  const done = refund.data;

  function save() {
    refund.mutate({
      key,
      body: {
        customerId: customer.id,
        orderId: order?.id ?? null,
        amount: paise,
        mode,
        reference: mode === 'cash' ? '' : reference.trim(),
        reason: reasonText,
      },
    });
  }

  return (
    <Modal
      opened
      title={done ? 'Refund saved' : `Refund ${customer.name}`}
      centered={!phone}
      fullScreen={phone}
      onClose={refund.isPending ? () => {} : onDone}
      withCloseButton={!refund.isPending}
      closeOnClickOutside={!refund.isPending && !done}
      closeOnEscape={!refund.isPending}
    >
      {done ? (
        <Stack>
          <Text fw={700} style={{ fontSize: 20 }}>
            Refund {done.number} saved
          </Text>
          <Text size="sm">{`Give ${customer.name} ${formatINR(done.amount)} ${mode === 'cash' ? 'in cash' : `by ${MODE_LABELS[mode]}`}.`}</Text>
          <PdfButtons docId={done.id} number={done.number} kind="Refund" />
          <Button size="md" fullWidth={phone} onClick={onDone} data-autofocus>
            Done
          </Button>
        </Stack>
      ) : (
        <Stack gap="md">
          <Text size="sm">
            This gives money back from the advance held for {customer.name}, {formatINR(held)} now. It cannot be undone.
          </Text>
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
            error={tooMuch ? messageFor('REFUND_EXCEEDS_BALANCE', '', { available: held }) : undefined}
            onChange={(v) => setAmount(v === '' ? '' : String(v))}
            data-autofocus
          />

          <div role="group" aria-label="How is it given back?">
            <Text size="sm" fw={500} mb={6}>
              How is it given back?
            </Text>
            <SimpleGrid cols={2} spacing="sm">
              {MODES.map((m) => (
                <Button key={m.value} size="lg" variant={mode === m.value ? 'filled' : 'default'} aria-pressed={mode === m.value} onClick={() => setMode(m.value)}>
                  {m.label}
                </Button>
              ))}
            </SimpleGrid>
          </div>
          {mode !== 'cash' && (
            <TextInput label="Reference (optional)" size="md" maxLength={100} value={reference} onChange={(e) => setReference(e.currentTarget.value)} />
          )}

          <Textarea label="Why is it being refunded?" autosize minRows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          {refund.error && <Alert color="red">{correctionErrorMessage('refund', refund.error)}</Alert>}
          <Button size="lg" fullWidth loading={refund.isPending} disabled={paise === null || tooMuch || !reasonText} onClick={save}>
            {paise === null || tooMuch ? 'Enter the amount' : reasonText ? `Refund ${formatINR(paise)}` : 'Say why'}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
