import { NumberInput, SimpleGrid, Stack, Text } from '@mantine/core';
import { financialYear } from '@vs/shared/fy.js';

const DOC_TYPES = [
  ['invoice', 'Invoice'],
  ['credit_note', 'Credit note'],
  ['receipt_voucher', 'Receipt voucher'],
  ['receipt', 'Receipt'],
  ['refund', 'Refund'],
  ['expense', 'Expense'],
  ['order', 'Order'],
];

/** First number of each document series for the current financial year (e.g. continuing from paper). */
export function NumberingTab({ values, set, errors }) {
  const fy = financialYear(new Date());
  const series = values.numberSeries;

  function setStart(docType, value) {
    const key = `${docType}:${fy.code}`;
    const next = { ...series };
    if (value === '') delete next[key];
    else next[key] = value;
    set('numberSeries', next);
  }

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Financial year {fy.label}. Leave empty to start at 1. Only takes effect before the first
        document of the year is issued.
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {DOC_TYPES.map(([docType, label]) => {
          const key = `${docType}:${fy.code}`;
          return (
            <NumberInput
              key={docType}
              label={`${label} — first number`}
              min={1}
              allowDecimal={false}
              value={series[key] ?? ''}
              onChange={(v) => setStart(docType, v)}
              error={errors[`numberSeries.${key}`]}
            />
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}
