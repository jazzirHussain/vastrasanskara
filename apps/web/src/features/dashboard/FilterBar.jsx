import { useState } from 'react';
import { Button, Drawer, Group, Radio, Select, Stack, TextInput } from '@mantine/core';
import { IconAdjustmentsHorizontal } from '@tabler/icons-react';
import { useAuth } from '../../auth/AuthContext.js';
import { useDesigners } from '../orders/ordersApi.js';

const PRESETS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['fy', 'This year'],
  ['custom', 'Custom'],
];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** "From" / "To" for a custom range; the address changes once a date is complete. */
function CustomDates({ filters, setFilters }) {
  const [from, setFrom] = useState(filters.from ?? '');
  const [to, setTo] = useState(filters.to ?? '');
  const change = (key, value, set) => {
    set(value);
    if (YMD.test(value)) setFilters({ preset: 'custom', [key]: value });
  };
  return (
    <Group grow mt="xs" wrap="nowrap">
      <TextInput label="From" placeholder="YYYY-MM-DD" value={from} onChange={(e) => change('from', e.currentTarget.value, setFrom)} inputMode="numeric" />
      <TextInput label="To" placeholder="YYYY-MM-DD" value={to} onChange={(e) => change('to', e.currentTarget.value, setTo)} inputMode="numeric" />
    </Group>
  );
}

function FiltersDrawer({ opened, onClose, filters, setFilters }) {
  const designers = useDesigners();
  const [draft, setDraft] = useState({ designerId: filters.designerId ?? '', priority: filters.priority ?? '', customerType: filters.customerType ?? '' });
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <Drawer opened={opened} onClose={onClose} title="Filters" position="bottom" size="auto">
      <Stack gap="md" pb="md">
        <Select
          label="Designer"
          placeholder="Everyone"
          clearable
          data={(designers.data?.items ?? []).map((d) => ({ value: d.id, label: d.name }))}
          value={draft.designerId || null}
          onChange={(v) => set({ designerId: v ?? '' })}
        />
        <Radio.Group label="Priority" value={draft.priority} onChange={(v) => set({ priority: v })}>
          <Group gap="md" mt={4}>
            <Radio value="" label="Any" />
            <Radio value="normal" label="Normal" />
            <Radio value="rush" label="Rush" />
          </Group>
        </Radio.Group>
        <Radio.Group label="Customer type" value={draft.customerType} onChange={(v) => set({ customerType: v })}>
          <Group gap="md" mt={4}>
            <Radio value="" label="Any" />
            <Radio value="individual" label="Individual" />
            <Radio value="business" label="Business" />
            <Radio value="film_production" label="Film" />
          </Group>
        </Radio.Group>
        <Button
          size="md"
          onClick={() => {
            setFilters({ designerId: draft.designerId || undefined, priority: draft.priority || undefined, customerType: draft.customerType || undefined });
            onClose();
          }}
        >
          Show
        </Button>
      </Stack>
    </Drawer>
  );
}

/** Preset chips (a scrollable row), custom dates, and for front desk and owner the Filters drawer. */
export function FilterBar({ filters, setFilters }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const active = ['designerId', 'priority', 'customerType'].filter((k) => filters[k]).length;
  return (
    <div style={{ marginBottom: 20 }}>
      <Group gap={8} wrap="nowrap" style={{ overflowX: 'auto', paddingBottom: 4 }}>
        {PRESETS.map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            radius="xl"
            variant={filters.preset === value ? 'filled' : 'default'}
            aria-pressed={filters.preset === value}
            style={{ flexShrink: 0, minHeight: 44 }}
            onClick={() => setFilters({ preset: value })}
          >
            {label}
          </Button>
        ))}
        {can('orders.read.all') && (
          <Button
            size="sm"
            radius="xl"
            variant={active ? 'light' : 'subtle'}
            leftSection={<IconAdjustmentsHorizontal size={18} aria-hidden />}
            style={{ flexShrink: 0, minHeight: 44 }}
            onClick={() => setOpen(true)}
          >
            {active ? `Filters (${active} on)` : 'Filters'}
          </Button>
        )}
      </Group>
      {filters.preset === 'custom' && <CustomDates filters={filters} setFilters={setFilters} />}
      {open && <FiltersDrawer opened onClose={() => setOpen(false)} filters={filters} setFilters={setFilters} />}
    </div>
  );
}
