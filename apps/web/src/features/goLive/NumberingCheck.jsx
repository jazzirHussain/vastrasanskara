import { Radio, Stack, Text, TextInput } from '@mantine/core';
import { formatDocumentNumber } from '@vs/shared/billing.js';

export const SERIES = [
  { type: 'invoice', label: 'GST bills', noun: 'GST bill' },
  { type: 'credit_note', label: 'Credit notes', noun: 'credit note' },
  { type: 'receipt_voucher', label: 'Receipt vouchers', noun: 'receipt voucher' },
  { type: 'refund', label: 'Refund vouchers', noun: 'refund voucher' },
  { type: 'receipt', label: 'Payment receipts', noun: 'payment receipt' },
];

const MAX_LAST = 999999;

function preview(prefix, fy, n) {
  try {
    return formatDocumentNumber(prefix, fy, n);
  } catch {
    return null;
  }
}

/** The form's starting value for a series: continue after start − 1 when a start is set. */
export function initialChoice(series) {
  return series.start > 1 ? { mode: 'continue', last: String(series.start - 1) } : { mode: 'first', last: '' };
}

/**
 * The old book's last number the choice stands for (0 = first this year), or null when not
 * valid. A series already in use keeps its start.
 */
export function lastNumber(series, choice) {
  if (series.used) return series.start - 1;
  if (choice.mode === 'first') return 0;
  const n = Number(choice.last);
  return /^\d+$/.test(choice.last) && n >= 1 && n <= MAX_LAST ? n : null;
}

const fieldsetStyle = { border: 0, padding: 0, margin: 0, minWidth: 0 };

/** One GST series: first this year, or continue after the old book's last number, with the next number shown. */
export function NumberingCheck({ series, fy, label, noun, choice, onChange }) {
  if (series.used) {
    return (
      <fieldset aria-label={label} style={fieldsetStyle}>
        <Text fw={600}>{label}</Text>
        <Text size="sm" c="var(--vs-muted)">
          Already in use. Next: {preview(series.prefix, fy, series.next)}
        </Text>
      </fieldset>
    );
  }
  const last = lastNumber(series, choice);
  const next = last === null ? null : preview(series.prefix, fy, last + 1);
  const name = `series-${series.type}`;
  return (
    <fieldset aria-label={label} style={fieldsetStyle}>
      <Stack gap={6}>
        <Text fw={600}>{label}</Text>
        <Radio
          name={name}
          value="first"
          label={`This is our first ${noun} this year`}
          checked={choice.mode === 'first'}
          onChange={() => onChange({ ...choice, mode: 'first' })}
        />
        <Radio
          name={name}
          value="continue"
          label="Continue after number"
          checked={choice.mode === 'continue'}
          onChange={() => onChange({ ...choice, mode: 'continue' })}
        />
        {choice.mode === 'continue' && (
          <TextInput
            label={`Last ${noun} number`}
            inputMode="numeric"
            maw={220}
            value={choice.last}
            onChange={(e) => onChange({ ...choice, last: e.currentTarget.value.replace(/\D/g, '').slice(0, 6) })}
            error={choice.last && next === null ? 'Enter a number from 1 to 999999' : null}
          />
        )}
        <Text size="sm" c="var(--vs-muted)">
          Next: {next ?? '—'}
        </Text>
      </Stack>
    </fieldset>
  );
}
