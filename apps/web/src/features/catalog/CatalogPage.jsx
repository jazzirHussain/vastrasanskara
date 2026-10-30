import { useState } from 'react';
import { Alert, Button, Loader, SegmentedControl, Stack, Text } from '@mantine/core';
import { formatINR } from '@vs/shared/money.js';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Money } from '../../components/Money.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { useCatalogItems } from './catalogApi.js';
import { ItemModal, KIND_LABELS } from './ItemModal.jsx';

const FILTERS = { all: undefined, active: true, inactive: false };
const rate = (bp) => `${bp / 100}%`;
const rupees = (paise) => formatINR(paise).replace(/\.00$/, '');

/** "18%" or "5% up to ₹2,500, then 18%". */
export function describeGst(slabs) {
  if (slabs.length === 1) return rate(slabs[0].rateBp);
  return slabs.map((s) => (s.upToUnitPrice === null ? `then ${rate(s.rateBp)}` : `${rate(s.rateBp)} up to ${rupees(s.upToUnitPrice)}`)).join(', ');
}

/** The price list: what the house sells, with the HSN/SAC and GST each bill line uses. */
export function CatalogPage() {
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const { data, isPending, error } = useCatalogItems({ active: FILTERS[filter] });

  return (
    <Stack gap={0}>
      <PageHeader title="Price list" action={<Button onClick={() => setEditing('new')}>Add item</Button>}>
        What you sell, with the code and GST each bill line uses.
      </PageHeader>
      <Stack>
        <SegmentedControl
          aria-label="Show"
          data={[
            { value: 'all', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {isPending && <Loader />}
        {error && <Alert color="red">{error.message}</Alert>}
        {data && data.items.length === 0 &&
          (filter === 'all' ? (
            <EmptyState
              title="No items yet. Add what you sell so bills fill in by themselves."
              body="Ask your accountant to confirm HSN/SAC codes and GST rates."
            />
          ) : (
            <EmptyState title="Nothing here" body="No items match this filter." />
          ))}
        {data && data.items.length > 0 && (
          <ResponsiveTable
            label="Price list"
            rows={data.items}
            rowKey={(i) => i.id}
            columns={[
              { key: 'name', header: 'Name', primary: true, render: (i) => <Text fw={600}>{i.name}</Text> },
              { key: 'kind', header: 'Kind', render: (i) => KIND_LABELS[i.kind] },
              { key: 'supply', header: 'Billed as', render: (i) => (i.supplyType === 'service' ? 'Service' : 'Goods'), hideOnPhone: true },
              { key: 'hsn', header: 'HSN/SAC', render: (i) => i.hsnSac },
              { key: 'gst', header: 'GST', render: (i) => describeGst(i.gstSlabs) },
              { key: 'price', header: 'Price', render: (i) => <Money paise={i.defaultPrice} /> },
              { key: 'status', header: 'Status', render: (i) => <StatusBadge status={i.active ? 'active' : 'inactive'} /> },
              {
                key: 'edit',
                header: '',
                align: 'right',
                render: (i) => (
                  <Button size="xs" variant="subtle" aria-label={`Edit ${i.name}`} onClick={() => setEditing(i)}>
                    Edit
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Stack>
      {editing && <ItemModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}
