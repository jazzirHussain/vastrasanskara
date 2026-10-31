import { useState } from 'react';
import { Anchor, Button, Group, NativeSelect, Paper, SimpleGrid, Stack, Switch, Text, TextInput } from '@mantine/core';
import { checkExpenseTax } from '@vs/shared/expenses.js';
import { GST_RATES_BP } from '@vs/shared/gst.js';
import { formatINR } from '@vs/shared/money.js';
import { paiseOf, rupeeText } from '../billing/rupees.js';
import { figuresOf, isInterState } from './expenseForm.js';

const CHIP_RATES = [500, 1800];
const rateLabel = (bp) => `${bp / 100} %`;
const figureText = (paise) => (paise > 0 ? rupeeText(paise) : '');

/** The GST problems for a form's figures, as unique plain messages. */
export function gstIssues(form, branchStateCode) {
  if (!form.gstOpen) return [];
  const gst = { ...figuresOf(form, branchStateCode), rateBp: form.gst.rateBp };
  return [...new Set(checkExpenseTax({ total: paiseOf(form.amount) ?? 0, gst }).map((i) => i.message))];
}

function AmountInput({ label, value, onChange }) {
  return (
    <TextInput
      label={label}
      size="md"
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.currentTarget.value.replace(/[^0-9.]/g, ''))}
    />
  );
}

/**
 * "Has a GST bill?": folded until switched on. With the total and the rate it works out the amount before GST and the
 * CGST/SGST or IGST; "Edit amounts" lets staff type the figures printed on the bill instead.
 * `errors` are the form's field messages by path (e.g. 'gst.billNo').
 */
export function GstSection({ form, setForm, branchStateCode, errors = {} }) {
  const [otherRate, setOtherRate] = useState(false);
  const { gst } = form;
  const set = (patch) => setForm((f) => ({ ...f, gst: { ...f.gst, ...patch } }));
  const vendor = Boolean(form.payee.vendorId);
  const inter = isInterState(form, branchStateCode);
  const figures = figuresOf(form, branchStateCode);
  const issues = gstIssues(form, branchStateCode);
  const mixed = gst.rateBp === null;
  const showOther = otherRate || (!mixed && !CHIP_RATES.includes(gst.rateBp));

  const typeFigures = () =>
    set({ edited: { taxable: figureText(figures.taxable), cgst: figureText(figures.cgst), igst: figureText(figures.igst) } });
  const chooseRate = (rateBp) => {
    set({ rateBp, edited: rateBp === null ? { taxable: figureText(paiseOf(form.amount) ?? 0), cgst: '', igst: '' } : null });
  };
  const editFigure = (field) => (text) => set({ edited: { ...gst.edited, [field]: text } });

  return (
    <Stack gap="sm">
      <Switch
        size="lg"
        label="Has a GST bill?"
        checked={form.gstOpen}
        onChange={(e) => {
          const gstOpen = e.currentTarget.checked;
          setForm((f) => ({ ...f, gstOpen, gst: { ...f.gst, gstin: f.gst.gstin || f.payee.gstin || '' } }));
        }}
      />
      {form.gstOpen && (
        <Paper withBorder p="md" radius="md">
          <Stack gap="md">
            <TextInput
              label="Supplier GSTIN"
              size="md"
              autoCapitalize="characters"
              maxLength={15}
              readOnly={vendor}
              description={vendor && !form.payee.gstin ? 'This vendor has no GSTIN saved. Add it under Workshop, or type the shop name instead.' : undefined}
              error={errors['payee.gstin']}
              value={vendor ? (form.payee.gstin ?? '') : gst.gstin}
              onChange={(e) => set({ gstin: e.currentTarget.value.toUpperCase() })}
            />
            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
              <TextInput label="Bill number" size="md" maxLength={16} error={errors['gst.billNo']} value={gst.billNo} onChange={(e) => set({ billNo: e.currentTarget.value })} />
              <TextInput
                label="Bill date"
                type="date"
                size="md"
                max={form.date}
                error={errors['gst.billDate']}
                value={gst.billDate || form.date}
                onChange={(e) => set({ billDate: e.currentTarget.value })}
              />
            </SimpleGrid>

            <div role="group" aria-label="GST rate">
              <Text size="md" fw={500} mb={6}>
                GST rate
              </Text>
              <Group gap="xs">
                {CHIP_RATES.map((bp) => (
                  <Button
                    key={bp}
                    size="md"
                    radius="xl"
                    variant={gst.rateBp === bp && !otherRate ? 'filled' : 'default'}
                    aria-pressed={gst.rateBp === bp && !otherRate}
                    onClick={() => {
                      setOtherRate(false);
                      chooseRate(bp);
                    }}
                  >
                    {rateLabel(bp)}
                  </Button>
                ))}
                <Button size="md" radius="xl" variant={showOther && !mixed ? 'filled' : 'default'} aria-pressed={showOther && !mixed} onClick={() => setOtherRate(true)}>
                  Other
                </Button>
                <Button
                  size="md"
                  radius="xl"
                  variant={mixed ? 'filled' : 'default'}
                  aria-pressed={mixed}
                  onClick={() => {
                    setOtherRate(false);
                    chooseRate(null);
                  }}
                >
                  Mixed rates
                </Button>
              </Group>
              {showOther && !mixed && (
                <NativeSelect
                  mt="xs"
                  size="md"
                  aria-label="Other GST rate"
                  data={GST_RATES_BP.map((bp) => ({ value: String(bp), label: rateLabel(bp) }))}
                  value={String(gst.rateBp)}
                  onChange={(e) => chooseRate(Number(e.currentTarget.value))}
                />
              )}
            </div>

            <Stack gap={2} aria-live="polite">
              <Text fw={600}>{`Before GST ${formatINR(figures.taxable)}`}</Text>
              {inter ? <Text fw={600}>{`IGST ${formatINR(figures.igst)}`}</Text> : <Text fw={600}>{`CGST ${formatINR(figures.cgst)} + SGST ${formatINR(figures.sgst)}`}</Text>}
              {mixed && !gst.edited && <Text size="sm" c="dimmed">Type the amounts from the bill.</Text>}
            </Stack>

            <Group gap="lg">
              <Anchor component="button" type="button" size="md" onClick={() => set({ interState: !inter })}>
                {inter ? 'This bill has CGST and SGST' : 'This bill has IGST'}
              </Anchor>
              {gst.edited ? (
                !mixed && (
                  <Anchor component="button" type="button" size="md" onClick={() => set({ edited: null })}>
                    Work out the amounts again
                  </Anchor>
                )
              ) : (
                <Anchor component="button" type="button" size="md" onClick={typeFigures}>
                  Edit amounts
                </Anchor>
              )}
            </Group>

            {gst.edited && (
              <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
                <AmountInput label="Before GST (₹)" value={gst.edited.taxable} onChange={editFigure('taxable')} />
                {inter ? (
                  <AmountInput label="IGST (₹)" value={gst.edited.igst} onChange={editFigure('igst')} />
                ) : (
                  <AmountInput label="CGST (₹), SGST is the same" value={gst.edited.cgst} onChange={editFigure('cgst')} />
                )}
              </SimpleGrid>
            )}

            {issues.map((message) => (
              <Text key={message} c="red" size="sm" role="alert">
                {message}
              </Text>
            ))}

            <Switch size="md" label="Can claim this GST back (ITC)" checked={gst.itcEligible} onChange={(e) => set({ itcEligible: e.currentTarget.checked })} />
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
