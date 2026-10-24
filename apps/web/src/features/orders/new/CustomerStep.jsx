import { useState } from 'react';
import { Button, Chip, Drawer, Group, NumberInput, Stack, Switch, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useAuth } from '../../../auth/AuthContext.js';
import { CustomerForm } from '../../customers/CustomerForm.jsx';
import { displayPhone } from '../../customers/CustomersPage.jsx';
import { useCreateCustomer, useCustomers } from '../../customers/customersApi.js';

const pick = (c) => ({ id: c.id, name: c.name, phone: c.phone });

/** Step 1: who the order is for, which designer leads it, and whether it is a rush. */
export function CustomerStep({ draft, update, designers }) {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const results = useCustomers(q);
  const create = useCreateCustomer();
  const [adding, setAdding] = useState(false);
  const found = q ? (results.data?.pages[0]?.items ?? []).slice(0, 6) : [];

  return (
    <Stack gap="xl">
      <section>
        <Title order={3} mb="sm">
          Customer
        </Title>
        {draft.customer ? (
          <Group className="vs-panel" p="md" justify="space-between">
            <div>
              <Text fw={600}>{draft.customer.name}</Text>
              <Text size="sm" c="var(--vs-muted)" className="vs-figures">
                {displayPhone(draft.customer.phone)}
              </Text>
            </div>
            <Button variant="subtle" onClick={() => update({ customer: null })}>
              Change customer
            </Button>
          </Group>
        ) : (
          <Stack gap="xs">
            <TextInput
              label="Find a customer"
              placeholder="Name or phone"
              leftSection={<IconSearch size={16} aria-hidden="true" />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              maw={420}
            />
            {found.length > 0 && (
              <div className="vs-stack" style={{ maxWidth: 420 }}>
                {found.map((c) => (
                  <UnstyledButton key={c.id} className="vs-stack-row" onClick={() => update({ customer: pick(c) })}>
                    <Text fw={600}>{c.name}</Text>
                    <Text size="sm" c="var(--vs-muted)" className="vs-figures">
                      {displayPhone(c.phone)}
                    </Text>
                  </UnstyledButton>
                ))}
              </div>
            )}
            {q && results.data && found.length === 0 && (
              <Text size="sm" c="var(--vs-muted)">
                No customer matches “{q}”.
              </Text>
            )}
            {can('customers.write') && (
              <div>
                <Button variant="light" onClick={() => setAdding(true)}>
                  Add new customer
                </Button>
              </div>
            )}
          </Stack>
        )}
      </section>

      <section>
        <Title order={3} mb="sm">
          Designer
        </Title>
        {designers.length === 0 ? (
          <Text c="var(--vs-muted)">No active designers. Add one under Users first.</Text>
        ) : (
          <Chip.Group multiple={false} value={draft.designerId} onChange={(designerId) => update({ designerId })}>
            <Group gap="xs">
              {designers.map((d) => (
                <Chip key={d.id} value={d.id} type="radio" variant="outline">
                  {d.name}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        )}
      </section>

      <Group align="flex-end" gap="xl">
        <Switch
          label="Rush order"
          description="Flags the order for the workshop"
          checked={draft.priority === 'rush'}
          onChange={(e) => update({ priority: e.currentTarget.checked ? 'rush' : 'normal' })}
          color="kumkum"
        />
        {can('money.view') && (
          <NumberInput
            label="Expected budget (₹)"
            description="Optional"
            min={0}
            thousandSeparator=","
            thousandsGroupStyle="lakh"
            value={draft.expectedBudget}
            onChange={(v) => update({ expectedBudget: v })}
            maw={220}
          />
        )}
      </Group>

      <Drawer opened={adding} onClose={() => { setAdding(false); create.reset(); }} title="Add customer" position="right" size="md">
        {adding && (
          <CustomerForm
            mutation={create}
            onSaved={(c) => {
              update({ customer: pick(c) });
              setAdding(false);
            }}
          />
        )}
      </Drawer>
    </Stack>
  );
}
