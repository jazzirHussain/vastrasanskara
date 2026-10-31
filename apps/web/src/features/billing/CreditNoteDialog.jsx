import { useMemo, useState } from 'react';
import { Alert, Button, Modal, NumberInput, Radio, Stack, Text, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { creditNoteFigures } from '@vs/shared/gst.js';
import { formatINR } from '@vs/shared/money.js';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { longDate } from '../../lib/dates.js';
import { correctionErrorMessage } from '../../lib/errorMessages.js';
import { useIssueCreditNote } from './billingApi.js';
import { PdfButtons } from './PdfButtons.jsx';
import { paiseOf } from './rupees.js';

/** What a correction-deadline warning says in plain words. */
function warningText(w) {
  if (w.code === 'CORRECTION_DEADLINE_NEAR') return `The last day to correct this bill in your GST return is ${longDate(w.deadline)}, which is close.`;
  if (w.code === 'CORRECTION_DEADLINE_PASSED') {
    return `The last day to correct this bill in your GST return was ${longDate(w.deadline)}. The credit note is saved; ask your accountant how to report it.`;
  }
  return null;
}

/**
 * Reduces an issued bill with a credit note (owner only): the whole bill, or an amount before
 * GST off chosen lines, with the GST and total shown as typed, worked out exactly as the server
 * will (creditNoteFigures). Mounted once per opening: the
 * Idempotency-Key is made here and sent again on every retry.
 */
export function CreditNoteDialog({ invoice, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [key] = useState(() => crypto.randomUUID());
  const issue = useIssueCreditNote(invoice.id);
  // Taxable already taken off each line by earlier credit notes.
  const credited = useMemo(() => {
    const byKey = {};
    for (const l of invoice.creditNotes.flatMap((n) => n.lines)) byKey[l.key] = (byKey[l.key] ?? 0) + l.taxable;
    return byKey;
  }, [invoice.creditNotes]);
  const reduced = invoice.creditNotes.length > 0;
  const [mode, setMode] = useState(reduced ? 'lines' : 'full');
  const [amounts, setAmounts] = useState({});
  const [reason, setReason] = useState('');

  const originalLines = useMemo(
    () =>
      invoice.lines.map((l) => ({
        key: l.key,
        hsnSac: l.item?.hsnSac ?? null,
        taxable: l.taxable,
        rateBp: l.gstRateBp,
        cgst: l.cgst,
        sgst: l.sgst,
        igst: l.igst,
        total: l.total,
      })),
    [invoice.lines],
  );
  const left = (l) => l.taxable - (credited[l.key] ?? 0);
  const typed = invoice.lines.map((l) => ({ line: l, paise: paiseOf(amounts[l.key] ?? '') }));
  const tooMuch = (l) => typed.some((t) => t.line.key === l.key && t.paise !== null && t.paise > left(l));
  const chosen = typed.filter((t) => t.paise !== null).map((t) => ({ key: t.line.key, taxable: t.paise }));
  const anyTooMuch = invoice.lines.some(tooMuch);

  let preview = null;
  if (mode === 'full' || (chosen.length > 0 && !anyTooMuch)) {
    try {
      preview = creditNoteFigures({
        originalLines,
        credits: mode === 'full' ? [] : chosen,
        earlier: invoice.creditNotes,
        invoiceTotal: invoice.totals.total,
        interState: invoice.placeOfSupply.interState,
        full: mode === 'full',
      });
    } catch {
      preview = null;
    }
  }
  const done = issue.data;
  const reasonText = reason.trim();
  const total = preview?.totals.total ?? 0;

  function save() {
    issue.mutate({
      key,
      body: { reason: reasonText, full: mode === 'full', lines: mode === 'full' ? [] : chosen },
    });
  }

  return (
    <Modal
      opened
      title={done ? 'Credit note saved' : `Reduce bill ${invoice.number}`}
      centered={!phone}
      fullScreen={phone}
      onClose={issue.isPending ? () => {} : onClose}
      withCloseButton={!issue.isPending}
      closeOnClickOutside={!issue.isPending && !done}
      closeOnEscape={!issue.isPending}
    >
      {done ? (
        <Stack>
          <Text fw={700} style={{ fontSize: 20 }}>
            Credit note {done.creditNote.number} saved
          </Text>
          <Text size="sm">
            The bill is reduced by {formatINR(done.creditNote.totals.total)}. Money already paid beyond the new total is kept as advance and can be refunded.
          </Text>
          {(done.warnings ?? []).map((w) => {
            const text = warningText(w);
            return (
              text && (
                <Alert key={w.code} color="haldi">
                  {text}
                </Alert>
              )
            );
          })}
          <PdfButtons docId={done.creditNote.id} number={done.creditNote.number} kind="Credit note" />
          <Button size="md" fullWidth={phone} onClick={onClose} data-autofocus>
            Done
          </Button>
        </Stack>
      ) : (
        <Stack gap="md">
          <Text size="sm">The bill stays as it is. A credit note takes this much off it, with its GST, and is kept with the bill.</Text>
          <Radio.Group value={mode} onChange={setMode} label="What do you want to reduce?">
            <Stack gap={6} mt={6}>
              <Radio value="full" label="Whole bill" disabled={reduced} description={reduced ? 'Not possible: the bill already has a credit note.' : undefined} />
              <Radio value="lines" label="Some lines" />
            </Stack>
          </Radio.Group>

          {mode === 'lines' &&
            invoice.lines.map((l) => (
              <div key={l.key} className="vs-panel" style={{ padding: 12 }}>
                <Text fw={600} size="sm" mb={6}>
                  {l.description}
                </Text>
                <NumberInput
                  label="Reduce by ₹"
                  description={`Before GST. The most is ${formatINR(left(l))}.`}
                  size="md"
                  inputMode="decimal"
                  min={0}
                  decimalScale={2}
                  allowNegative={false}
                  hideControls
                  thousandSeparator=""
                  value={amounts[l.key] ?? ''}
                  disabled={left(l) <= 0}
                  error={tooMuch(l) ? `The most you can reduce this line by is ${formatINR(left(l))}.` : undefined}
                  onChange={(v) => setAmounts({ ...amounts, [l.key]: v === '' ? '' : String(v) })}
                />
              </div>
            ))}

          {preview && (
            <div className="vs-panel" style={{ padding: 12 }}>
              <Text size="sm">{`Before GST ${formatINR(preview.totals.taxable)}`}</Text>
              <Text size="sm">{`GST ${formatINR(preview.totals.tax)}`}</Text>
              <Text fw={700}>{`Credit note total ${formatINR(preview.totals.total)}`}</Text>
            </div>
          )}

          <Textarea label="Why is the bill being reduced?" autosize minRows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          {issue.error && <Alert color="red">{correctionErrorMessage('creditNote', issue.error)}</Alert>}
          <Button size="lg" fullWidth loading={issue.isPending} disabled={!preview || !reasonText} onClick={save}>
            {!preview ? 'Enter the amounts' : reasonText ? `Issue credit note of ${formatINR(total)}` : 'Say why'}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
