import { useState } from 'react';
import { Button, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { showQty } from './qty.js';
import { usePicker } from './stockApi.js';

/** "Red silk · Raw silk — 8.5 m free": what a picker row says. Quantities only, never a price. */
export const pickerLabel = (it) => `${[it.name, it.brand].filter(Boolean).join(' · ')} — ${showQty(it.free, it.usageUnit)} free`;

/** Choosing a stock item for a garment: a search box and matching items with their free stock. `exclude` hides chosen ids. */
export function ItemPicker({ onPick, exclude = [] }) {
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 200);
  const picker = usePicker(q);
  const rows = (picker.data ?? []).filter((it) => !exclude.includes(it.id));
  return (
    <Stack gap={6}>
      <TextInput
        aria-label="Find material"
        placeholder="Find material"
        leftSection={<IconSearch size={16} aria-hidden="true" />}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        maxLength={40}
        autoFocus
      />
      {picker.isPending && <Loader size="sm" />}
      {picker.data && rows.length === 0 && (
        <Text size="sm" c="var(--vs-muted)">
          No items match
        </Text>
      )}
      {rows.map((it) => (
        <Button
          key={it.id}
          variant="default"
          size="md"
          fullWidth
          justify="flex-start"
          onClick={() => onPick(it)}
          styles={{ label: { whiteSpace: 'normal', textAlign: 'left' } }}
        >
          {pickerLabel(it)}
        </Button>
      ))}
    </Stack>
  );
}
