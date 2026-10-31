import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Button, Group, NumberInput, Radio, Select, Stack, Text } from '@mantine/core';
import { GST_RATES_BP } from '@vs/shared/gst.js';
import { rupeesToPaise } from '@vs/shared/money.js';

export const CLOTHING_SLABS = [
  { upToUnitPrice: 250000, rateBp: 500 },
  { upToUnitPrice: null, rateBp: 1800 },
];
export const ONE_RATE_SLABS = [{ upToUnitPrice: null, rateBp: 1800 }];

const RATE_OPTIONS = GST_RATES_BP.map((bp) => ({ value: String(bp), label: `${bp / 100}%` }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rupees = (paise) => paise / 100;
const AMOUNT = /^\d+(\.\d{1,2})?$/;
let rowCounter = 0;
const newRowId = () => `slab-${++rowCounter}`;

/** A rupee amount field that keeps what is typed ("12.", empty) and passes on only valid, positive amounts. */
function AmountInput({ paise, onCommit, ...props }) {
  const [text, setText] = useState(String(rupees(paise)));
  useEffect(() => {
    // Follow outside changes (a preset) but never overwrite a half-typed value.
    if (AMOUNT.test(text) && rupeesToPaise(text) !== paise) setText(String(rupees(paise)));
  }, [paise]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <NumberInput
      {...props}
      value={text}
      onChange={(v) => {
        const next = String(v);
        setText(next);
        if (AMOUNT.test(next) && rupeesToPaise(next) > 0) onCommit(rupeesToPaise(next));
      }}
    />
  );
}

function presetOf(slabs) {
  if (same(slabs, CLOTHING_SLABS)) return 'clothing';
  if (slabs.length === 1) return 'one';
  return 'custom';
}

/**
 * Chooses how GST is charged: the clothing preset, one rate, or a list of slabs (a rate up to a
 * price per piece). `value` and `onChange` use the API shape [{ upToUnitPrice (paise|null), rateBp }].
 */
export function SlabEditor({ value, onChange, error, showSlabs, onShowSlabs }) {
  const preset = presetOf(value);
  const advanced = showSlabs || preset === 'custom';
  const ids = useRef([]);
  if (ids.current.length !== value.length) ids.current = value.map(newRowId);

  function setRow(index, patch) {
    onChange(value.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }
  function addSlab() {
    const last = value.length - 1;
    const before = value.slice(0, last);
    const ceiling = (before.at(-1)?.upToUnitPrice ?? 0) + 100000;
    ids.current = [...ids.current.slice(0, last), newRowId(), ids.current[last]];
    onChange([...before, { upToUnitPrice: ceiling, rateBp: value[last].rateBp }, value[last]]);
  }

  return (
    <Stack gap="xs">
      <Radio.Group
        label="GST"
        description="Your accountant tells you which rate applies."
        value={preset === 'custom' ? '' : preset}
        onChange={(next) => onChange(next === 'clothing' ? CLOTHING_SLABS : [{ ...ONE_RATE_SLABS[0], rateBp: value.at(-1).rateBp }])}
        error={error}
      >
        <Stack gap={8} mt={6}>
          <Radio value="clothing" label="Clothing (5% up to ₹2,500 a piece, 18% above)" />
          <Radio value="one" label="One rate" />
        </Stack>
      </Radio.Group>

      {preset === 'one' && (
        <Select
          label="GST rate"
          data={RATE_OPTIONS}
          allowDeselect={false}
          value={String(value[0].rateBp)}
          onChange={(rate) => onChange([{ upToUnitPrice: null, rateBp: Number(rate) }])}
        />
      )}

      {!advanced && (
        <div>
          <Button variant="subtle" size="compact-sm" onClick={onShowSlabs}>
            Edit slabs
          </Button>
        </div>
      )}

      {advanced && (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Each rate applies to pieces priced up to its limit (before GST). The last rate covers everything above.
          </Text>
          {value.map((slab, index) => {
            const last = index === value.length - 1;
            return (
              <Group key={ids.current[index]} align="flex-end" wrap="nowrap" gap="xs">
                {last ? (
                  <Text style={{ flex: 1 }} size="sm">
                    {index === 0 ? 'Every price' : 'Above that'}
                  </Text>
                ) : (
                  <AmountInput
                    style={{ flex: 1 }}
                    label="Up to (₹ a piece)"
                    decimalScale={2}
                    thousandSeparator=","
                    thousandsGroupStyle="lakh"
                    paise={slab.upToUnitPrice}
                    onCommit={(upToUnitPrice) => setRow(index, { upToUnitPrice })}
                  />
                )}
                <Select
                  style={{ width: 96 }}
                  aria-label={`GST rate, slab ${index + 1}`}
                  data={RATE_OPTIONS}
                  allowDeselect={false}
                  value={String(slab.rateBp)}
                  onChange={(rate) => setRow(index, { rateBp: Number(rate) })}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="lg"
                  aria-label={`Remove slab ${index + 1}`}
                  disabled={value.length === 1}
                  onClick={() => {
                    ids.current = ids.current.filter((_, i) => i !== index);
                    const next = value.filter((_, i) => i !== index);
                    onChange(last ? next.map((s, i) => (i === next.length - 1 ? { ...s, upToUnitPrice: null } : s)) : next);
                  }}
                >
                  ✕
                </ActionIcon>
              </Group>
            );
          })}
          <div>
            <Button variant="light" size="compact-sm" onClick={addSlab} disabled={value.length >= 5}>
              Add a slab
            </Button>
          </div>
        </Stack>
      )}
    </Stack>
  );
}
