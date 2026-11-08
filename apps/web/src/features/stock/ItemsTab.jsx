import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Chip, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { LowStockList } from './LowStockList.jsx';
import { showQty } from './qty.js';
import { useLowStock, useStockItems } from './stockApi.js';

function ItemRow({ item: it }) {
  const sub = [it.brand, it.colour].filter(Boolean).join(' · ');
  return (
    <Link
      to={`/stock/items/${it.id}`}
      className="vs-row"
      style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 64, padding: '10px 12px', color: 'inherit', textDecoration: 'none', borderBottom: '1px solid var(--vs-rule)' }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text fw={600}>{it.name}</Text>
        {sub && (
          <Text size="sm" c="var(--vs-muted)">
            {sub}
          </Text>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        <Text fw={700} size="xl" className="vs-figures" c={it.low ? 'red.8' : undefined}>
          {showQty(it.free, it.usageUnit)}
        </Text>
        {it.reserved > 0 && (
          <Text size="xs" c="var(--vs-muted)">
            {`${showQty(it.reserved, it.usageUnit)} reserved`}
          </Text>
        )}
      </div>
    </Link>
  );
}

/** Stock items at a glance: what is running low first, then every item with its free stock. */
export function ItemsTab({ onOrderMore }) {
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const [category, setCategory] = useState('all');
  const low = useLowStock();
  const list = useStockItems({ ...(q && { q }), ...(category !== 'all' && { category }) });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  // Categories seen so far, so the chips stay put while one of them filters the list.
  const seen = useRef(new Set());
  for (const r of rows) if (r.category) seen.current.add(r.category);
  const categories = [...seen.current].sort();
  const filtered = Boolean(q || category !== 'all');

  return (
    <Stack gap="md">
      <LowStockList items={low.data} onOrderMore={onOrderMore} />
      <TextInput
        aria-label="Search stock"
        placeholder="Name"
        leftSection={<IconSearch size={16} aria-hidden="true" />}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        maxLength={40}
        maw={420}
      />
      {categories.length > 0 && (
        <Chip.Group multiple={false} value={category} onChange={setCategory}>
          <Group gap="xs">
            <Chip value="all" type="radio" variant="outline" size="md">
              All
            </Chip>
            {categories.map((c) => (
              <Chip key={c} value={c} type="radio" variant="outline" size="md">
                {c}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      )}
      <section aria-label="All items">
        {list.isPending && <Loader />}
        {list.error && <Alert color="red">{list.error.message}</Alert>}
        {list.data && rows.length === 0 && (
          <EmptyState title={filtered ? 'No items match' : 'No stock items yet.'} body={filtered ? 'Try another name or category.' : 'Add the fabric, buttons and threads you keep on the shelves.'} />
        )}
        {rows.length > 0 && (
          <div className="vs-panel" style={{ overflow: 'hidden' }}>
            {rows.map((it) => (
              <ItemRow key={it.id} item={it} />
            ))}
          </div>
        )}
        <LoadMore query={list} />
      </section>
    </Stack>
  );
}
