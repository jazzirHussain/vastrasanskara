import { useState } from 'react';
import { Alert, Autocomplete, Button, Checkbox, Group, Modal, SimpleGrid, Stack, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { fieldErrors } from '../../lib/fieldErrors.js';
import { paiseInput, qtyInput, qtyText } from './qty.js';
import { useCreateItem, useUpdateItem } from './stockApi.js';

const UNIT_SUGGESTIONS = ['metre', 'piece', 'gram', 'spool', 'set'];
const rupeesText = (paise) => (paise === null || paise === undefined ? '' : String(paise / 100));

function startForm(item) {
  if (!item) {
    return {
      name: '', brand: '', category: '', colour: '', usageUnit: '', purchaseUnit: '', factor: '', step: '1', reorderLevel: '',
      sellingPrice: '', hasOpening: false, openingQty: '', openingCost: '',
    };
  }
  return {
    name: item.name, brand: item.brand, category: item.category, colour: item.colour, usageUnit: item.usageUnit,
    purchaseUnit: item.purchaseUnit, factor: qtyText(item.factor), step: qtyText(item.step), reorderLevel: item.reorderLevel ? qtyText(item.reorderLevel) : '',
    sellingPrice: rupeesText(item.sellingPrice), hasOpening: false, openingQty: '', openingCost: '',
  };
}

/** The form as the API body, with the problems found in it ({} when none). */
function toBody(form, isNew) {
  const errors = {};
  const usageUnit = form.usageUnit.trim();
  const purchaseUnit = form.purchaseUnit.trim() || usageUnit;
  const sameUnit = purchaseUnit.toLowerCase() === usageUnit.toLowerCase();
  const factor = sameUnit ? 1000 : qtyInput(form.factor);
  const step = qtyInput(form.step);
  const reorderLevel = form.reorderLevel.trim() ? qtyInput(form.reorderLevel) : 0;
  const sellingPrice = form.sellingPrice.trim() ? paiseInput(form.sellingPrice) : null;
  if (!form.name.trim()) errors.name = 'Enter a name';
  if (!usageUnit) errors.usageUnit = 'Say how you measure it';
  if (!factor) errors.factor = 'Enter how many';
  if (!step) errors.step = 'Enter a step';
  if (reorderLevel === null) errors.reorderLevel = 'Enter a quantity';
  if (form.sellingPrice.trim() && sellingPrice === null) errors.sellingPrice = 'Enter an amount';
  const body = {
    name: form.name.trim(), brand: form.brand.trim(), category: form.category.trim(), colour: form.colour.trim(),
    usageUnit, purchaseUnit, factor, step, reorderLevel, sellingPrice,
  };
  if (isNew) {
    body.opening = null;
    if (form.hasOpening) {
      const quantity = qtyInput(form.openingQty);
      const unitCost = paiseInput(form.openingCost);
      if (!quantity) errors.openingQty = 'Enter how many';
      if (unitCost === null) errors.openingCost = 'Enter the cost';
      body.opening = { quantity, unitCost };
    }
  }
  return { body, errors };
}

/** Add a stock item (with stock already on the shelf), or change one: `item` given to edit. */
export function ItemModal({ item = null, categories = [], onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const isNew = !item;
  const [key] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState(() => startForm(item));
  const [shown, setShown] = useState({});
  const create = useCreateItem();
  const update = useUpdateItem(item?.id);
  const save = isNew ? create : update;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const errors = { ...fieldErrors(save.error), ...shown };
  const usage = form.usageUnit.trim() || 'unit';
  const purchase = form.purchaseUnit.trim();
  const askFactor = purchase && purchase.toLowerCase() !== form.usageUnit.trim().toLowerCase();

  const submit = async () => {
    const { body, errors: found } = toBody(form, isNew);
    setShown(found);
    if (Object.keys(found).length) return;
    try {
      if (isNew) await create.mutateAsync({ body, key });
      else {
        const changes = Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(item[k])));
        if (Object.keys(changes).length) await update.mutateAsync({ version: item.version, ...changes });
      }
      onClose();
    } catch {
      // Shown below from save.error.
    }
  };

  return (
    <Modal opened title={isNew ? 'Add stock item' : `Edit ${item.name}`} centered={!phone} fullScreen={phone} size="lg" onClose={save.isPending ? () => {} : onClose}>
      <Stack gap="sm">
        <TextInput label="Name" placeholder="Red raw silk" value={form.name} onChange={(e) => set({ name: e.currentTarget.value })} error={errors.name} maxLength={80} data-autofocus />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput label="Brand" value={form.brand} onChange={(e) => set({ brand: e.currentTarget.value })} maxLength={60} />
          <Autocomplete label="Category" data={categories} value={form.category} onChange={(v) => set({ category: v })} maxLength={40} />
          <TextInput label="Colour" value={form.colour} onChange={(e) => set({ colour: e.currentTarget.value })} maxLength={40} />
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Autocomplete label="We use it in" data={UNIT_SUGGESTIONS} value={form.usageUnit} onChange={(v) => set({ usageUnit: v })} error={errors.usageUnit} maxLength={20} />
          <Autocomplete label="We buy it in" placeholder={form.usageUnit || 'packet'} data={['packet', 'box', 'roll', ...UNIT_SUGGESTIONS]} value={form.purchaseUnit} onChange={(v) => set({ purchaseUnit: v })} maxLength={20} />
        </SimpleGrid>
        {askFactor && (
          <TextInput label={`How many ${usage} in one ${purchase}?`} inputMode="decimal" value={form.factor} onChange={(e) => set({ factor: e.currentTarget.value })} error={errors.factor} />
        )}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="+/− step" description={`Each tap adds or takes this many ${usage}`} inputMode="decimal" value={form.step} onChange={(e) => set({ step: e.currentTarget.value })} error={errors.step} />
          <TextInput label="Reorder when free stock falls below" inputMode="decimal" value={form.reorderLevel} onChange={(e) => set({ reorderLevel: e.currentTarget.value })} error={errors.reorderLevel} />
        </SimpleGrid>
        <TextInput label={`Selling price per ${usage} (optional)`} leftSection="₹" inputMode="decimal" value={form.sellingPrice} onChange={(e) => set({ sellingPrice: e.currentTarget.value })} error={errors.sellingPrice} />
        {isNew && (
          <>
            <Checkbox label="Already have some?" checked={form.hasOpening} onChange={(e) => set({ hasOpening: e.currentTarget.checked })} size="md" />
            {form.hasOpening && (
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label={`How many ${usage} now?`} inputMode="decimal" value={form.openingQty} onChange={(e) => set({ openingQty: e.currentTarget.value })} error={errors.openingQty} />
                <TextInput label={`Cost per ${usage} (₹)`} inputMode="decimal" value={form.openingCost} onChange={(e) => set({ openingCost: e.currentTarget.value })} error={errors.openingCost} />
              </SimpleGrid>
            )}
          </>
        )}
        {save.error && !Object.keys(fieldErrors(save.error)).length && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end" grow={phone} mt="xs">
          <Button variant="default" size="md" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button size="md" loading={save.isPending} onClick={submit}>
            {isNew ? 'Add item' : 'Save'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
