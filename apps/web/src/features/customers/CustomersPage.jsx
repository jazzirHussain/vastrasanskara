import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Drawer, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useAuth } from '../../auth/AuthContext.js';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { CustomerForm, CUSTOMER_TYPES } from './CustomerForm.jsx';
import { useCreateCustomer, useCustomers } from './customersApi.js';

/** '+919876543210' → '98765 43210'; other countries keep their international form. */
export function displayPhone(phone) {
  const india = /^\+91(\d{5})(\d{5})$/.exec(phone ?? '');
  return india ? `${india[1]} ${india[2]}` : phone;
}

const typeLabel = (type) => CUSTOMER_TYPES.find((t) => t.value === type)?.label ?? type;

export function CustomersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const customers = useCustomers(q);
  const create = useCreateCustomer();
  const [adding, setAdding] = useState(false);
  const rows = customers.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Stack gap={0}>
      <PageHeader
        title="Customers"
        action={can('customers.write') && <Button onClick={() => setAdding(true)}>Add customer</Button>}
      />
      <TextInput
        aria-label="Search customers"
        placeholder="Search by name or phone"
        leftSection={<IconSearch size={16} aria-hidden="true" />}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        mb="md"
        maw={420}
      />
      {customers.isPending && <Loader />}
      {customers.error && <Alert color="red">{customers.error.message}</Alert>}
      {customers.data && rows.length === 0 && (
        q ? (
          <EmptyState title="No customers match" body={`Nobody's name starts with "${q}" and no phone contains it.`} />
        ) : (
          <EmptyState
            title="No customers yet"
            body="Add a customer to record their measurements and take their first order."
          />
        )
      )}
      {rows.length > 0 && (
        <ResponsiveTable
          label="Customers"
          rows={rows}
          rowKey={(c) => c.id}
          onRowClick={(c) => navigate(`/customers/${c.id}`)}
          columns={[
            { key: 'name', header: 'Name', primary: true, render: (c) => <Text fw={600}>{c.name}</Text> },
            { key: 'phone', header: 'Phone', render: (c) => <span className="vs-figures">{displayPhone(c.phone)}</span> },
            { key: 'type', header: 'Type', render: (c) => typeLabel(c.type) },
            { key: 'email', header: 'Email', hideOnPhone: true, render: (c) => c.email ?? '' },
          ]}
        />
      )}
      <LoadMore query={customers} />
      <Drawer opened={adding} onClose={() => { setAdding(false); create.reset(); }} title="Add customer" position="right" size="md">
        {adding && <CustomerForm mutation={create} onSaved={(c) => navigate(`/customers/${c.id}`)} />}
      </Drawer>
    </Stack>
  );
}
