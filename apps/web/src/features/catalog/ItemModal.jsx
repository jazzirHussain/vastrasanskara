import { useState } from 'react';
import { Alert, Button, Group, Modal, MultiSelect, NumberInput, Radio, SegmentedControl, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { rupeesToPaise } from '@vs/shared/money.js';
import { catalogItemSchema } from '@vs/shared/schemas/catalog.js';
import { useAuth } from '../../auth/AuthContext.js';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { fieldErrors } from '../../lib/fieldErrors.js';
import { useSettings } from '../settings/settingsApi.js';
import { useCatalogItems, useSaveItem } from './catalogApi.js';
import { CLOTHING_SLABS, ONE_RATE_SLABS, SlabEditor } from './SlabEditor.jsx';
import { ItemPicker } from '../stock/ItemPicker.jsx';
import { useStockItem } from '../stock/stockApi.js';

export const KIND_LABELS = {
  garment: 'Garment',
  stitching_service: 'Stitching',
  material: 'Material',
  extra_charge: 'Extra charge',
};
export const CHARGE_LABELS = { rush: 'Rush', alteration: 'Alteration', rework: 'Rework' };
const KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }));
const UNIT_OPTIONS = [
  { value: 'PCS', label: 'Pieces' },
  { value: 'MTR', label: 'Metres' },
  { value: 'SET', label: 'Set' },
  { value: 'NOS', label: 'Numbers' },
  { value: 'OTH', label: 'Other' },
];
const CHARGE_OPTIONS = [{ value: 'none', label: 'None' }, ...Object.entries(CHARGE_LABELS).map(([value, label]) => ({ value, label }))];
const GARMENT_KINDS = ['garment', 'stitching_service'];
const suggestedSupply = (kind) => (kind === 'stitching_service' || kind === 'extra_charge' ? 'service' : 'goods');
const suggestedSlabs = (kind) => (GARMENT_KINDS.includes(kind) ? CLOTHING_SLABS : ONE_RATE_SLABS);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function startForm(item) {
  if (!item) {
    return {
      name: '', kind: 'garment', supplyType: 'goods', hsnSac: '', unit: 'PCS', price: '',
      gstSlabs: CLOTHING_SLABS, garmentTypes: [], chargeFor: null, active: true, stockItemId: null, stockItemName: null,
    };
  }
  return {
    name: item.name, kind: item.kind, supplyType: item.supplyType, hsnSac: item.hsnSac, unit: item.unit,
    price: item.defaultPrice / 100, gstSlabs: item.gstSlabs, garmentTypes: item.garmentTypes,
    chargeFor: item.chargeFor, active: item.active, stockItemId: item.stockItemId ?? null, stockItemName: null,
  };
}

/** The API shape of the form (kind-specific fields cleared when they do not apply). */
function toValues(form) {
  let defaultPrice = 0;
  try {
    defaultPrice = form.price === '' ? 0 : rupeesToPaise(String(form.price));
  } catch {
    defaultPrice = -1;
  }
  return {
    name: form.name.trim(),
    kind: form.kind,
    supplyType: form.supplyType,
    hsnSac: form.hsnSac.trim(),
    unit: form.unit,
    defaultPrice,
    gstSlabs: form.gstSlabs,
    garmentTypes: GARMENT_KINDS.includes(form.kind) ? form.garmentTypes : [],
    chargeFor: form.kind === 'extra_charge' ? form.chargeFor : null,
    active: form.active,
    // Only a material can take from stock; a link is cleared when the kind changes.
    ...((form.kind === 'material' || form.stockItemId) && { stockItemId: form.kind === 'material' ? form.stockItemId : null }),
  };
}

function localErrors(values) {
  const result = catalogItemSchema.safeParse(values);
  if (result.success) return {};
  const errors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (errors[field]) continue;
    if (field === 'name') errors[field] = 'Enter a name';
    else if (field === 'hsnSac' && !values.hsnSac) errors[field] = 'Enter the HSN/SAC code';
    else errors[field] = issue.message;
  }
  return errors;
}

/** Which of the form's garment types / charge the other item already bills, in plain words. */
function takenWhat(error, values, activeItems, labelOf) {
  const other = activeItems.find((i) => i.id === error.details?.itemId);
  const parts = [
    ...(other?.garmentTypes ?? []).filter((t) => values.garmentTypes.includes(t)).map(labelOf),
    ...(other?.chargeFor && other.chargeFor === values.chargeFor ? [`${CHARGE_LABELS[other.chargeFor].toLowerCase()} charges`] : []),
  ];
  return parts.length ? parts.join(', ') : 'this';
}

/** "Take from stock (optional)": the stock item a material sells from, chosen with the stock picker. */
function StockLink({ stockItemId, name, onChange }) {
  const [picking, setPicking] = useState(false);
  const linked = useStockItem(stockItemId && !name ? stockItemId : null);
  const shown = name ?? linked.data?.name;
  if (picking) {
    return (
      <ItemPicker
        onPick={(it) => {
          onChange(it.id, it.name);
          setPicking(false);
        }}
      />
    );
  }
  if (!stockItemId) {
    return (
      <div>
        <Button variant="light" onClick={() => setPicking(true)}>
          Take from stock (optional)
        </Button>
        <Text size="xs" c="var(--vs-muted)" mt={4}>
          Selling it on a bill then takes it out of stock.
        </Text>
      </div>
    );
  }
  return (
    <Group gap="xs">
      <Text size="sm">{`Taken from stock: ${shown ?? '…'}`}</Text>
      <Button variant="subtle" size="compact-md" onClick={() => setPicking(true)}>
        Change
      </Button>
      <Button variant="subtle" size="compact-md" color="kumkum" onClick={() => onChange(null)}>
        Remove
      </Button>
    </Group>
  );
}

/** Add (item null) or edit one price-list item; an edit sends only the fields that changed, with `version`. */
export function ItemModal({ item, onClose }) {
  const { can } = useAuth();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const settings = useSettings();
  const activeItems = useCatalogItems({ active: true });
  const save = useSaveItem();
  const [form, setForm] = useState(() => startForm(item));
  const [supplyChosen, setSupplyChosen] = useState(Boolean(item));
  const [showSlabs, setShowSlabs] = useState(false);
  const [localError, setLocalError] = useState({});
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const garmentTypes = settings.data?.garmentTypes ?? [];
  const labelOf = (key) => garmentTypes.find((g) => g.key === key)?.label ?? key;
  const errors = { ...fieldErrors(save.error), ...localError };
  const conflict = save.error?.code === 'CONFLICT';
  const taken = save.error?.code === 'CATALOG_MAPPING_TAKEN';

  function chooseKind(kind) {
    // Suggestions are for new items only: an existing item's GST and supply type never change by themselves.
    if (item) return set({ kind });
    const slabsAreDefault = same(form.gstSlabs, CLOTHING_SLABS) || same(form.gstSlabs, ONE_RATE_SLABS);
    set({
      kind,
      ...(supplyChosen ? {} : { supplyType: suggestedSupply(kind) }),
      ...(slabsAreDefault ? { gstSlabs: suggestedSlabs(kind) } : {}),
    });
  }

  async function submit(event) {
    event.preventDefault();
    const values = toValues(form);
    const problems = localErrors(values);
    setLocalError(problems);
    if (Object.keys(problems).length) return;
    save.reset();
    try {
      if (!item) {
        await save.mutateAsync({ body: values });
      } else {
        const original = toValues(startForm(item));
        const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => !same(value, original[key])));
        if (Object.keys(changes).length) await save.mutateAsync({ id: item.id, body: { version: item.version, ...changes } });
      }
      onClose();
    } catch {
      // Shown below from save.error.
    }
  }

  return (
    <Modal opened onClose={onClose} title={item ? `Edit ${item.name}` : 'Add item'} fullScreen={phone}>
      <form onSubmit={submit}>
        <Stack>
          {save.error && (
            <Alert color="red">
              <Group justify="space-between">
                {taken
                  ? `${save.error.details?.name ?? 'Another item'} already bills ${takenWhat(save.error, toValues(form), activeItems.data?.items ?? [], labelOf)}. Change that item first.`
                  : save.error.message}
                {conflict && (
                  <Button
                    size="xs"
                    variant="white"
                    onClick={() => {
                      save.refresh();
                      onClose();
                    }}
                  >
                    Reload
                  </Button>
                )}
              </Group>
            </Alert>
          )}

          <TextInput label="Name" placeholder="Blouse stitching, Lining fabric…" value={form.name} onChange={(e) => set({ name: e.currentTarget.value })} error={errors.name} />

          <div>
            <Text size="sm" fw={500} mb={4}>
              What is it?
            </Text>
            <SegmentedControl
              fullWidth
              orientation={phone ? 'vertical' : 'horizontal'}
              aria-label="What is it?"
              data={KIND_OPTIONS}
              value={form.kind}
              onChange={chooseKind}
            />
          </div>

          <Radio.Group
            label="Goods or service"
            description="Stitching with the client's fabric is usually a service."
            value={form.supplyType}
            onChange={(supplyType) => {
              setSupplyChosen(true);
              set({ supplyType });
            }}
            error={errors.supplyType}
          >
            <Group mt={6}>
              <Radio value="goods" label="Goods" />
              <Radio value="service" label="Service" />
            </Group>
          </Radio.Group>

          <TextInput
            label="HSN/SAC code"
            description="Your accountant gives you this. Services use a code starting 99."
            inputMode="numeric"
            value={form.hsnSac}
            onChange={(e) => set({ hsnSac: e.currentTarget.value })}
            error={errors.hsnSac}
          />

          <Group grow align="flex-start">
            <Select label="Sold by" data={UNIT_OPTIONS} allowDeselect={false} value={form.unit} onChange={(unit) => set({ unit })} error={errors.unit} />
            <NumberInput
              label="Default price (₹)"
              description="Before GST"
              min={0}
              decimalScale={2}
              thousandSeparator=","
              thousandsGroupStyle="lakh"
              value={form.price}
              onChange={(price) => set({ price })}
              error={errors.defaultPrice}
            />
          </Group>

          <SlabEditor value={form.gstSlabs} onChange={(gstSlabs) => set({ gstSlabs })} error={errors.gstSlabs} showSlabs={showSlabs} onShowSlabs={() => setShowSlabs(true)} />

          {GARMENT_KINDS.includes(form.kind) && (
            <MultiSelect
              label="Bill these garment types with this item"
              description="Orders for these garments pick this item by themselves."
              data={garmentTypes.map((g) => ({ value: g.key, label: g.label }))}
              value={form.garmentTypes}
              onChange={(next) => set({ garmentTypes: next })}
              error={errors.garmentTypes}
            />
          )}

          {form.kind === 'extra_charge' && (
            <Select
              label="Use for"
              description="Rush, alteration and rework charges are added to bills by themselves."
              data={CHARGE_OPTIONS}
              allowDeselect={false}
              value={form.chargeFor ?? 'none'}
              onChange={(next) => set({ chargeFor: next === 'none' ? null : next })}
              error={errors.chargeFor}
            />
          )}

          {form.kind === 'material' && can('stock.view') && (
            <StockLink
              stockItemId={form.stockItemId}
              name={form.stockItemName}
              onChange={(stockItemId, stockItemName = null) => set({ stockItemId, stockItemName })}
            />
          )}

          <Switch label="Active" checked={form.active} onChange={(e) => set({ active: e.currentTarget.checked })} />

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save item
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
