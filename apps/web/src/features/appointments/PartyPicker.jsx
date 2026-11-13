import { useState } from 'react';
import { Anchor, Badge, Group, Loader, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useCustomer, useCustomers } from '../customers/customersApi.js';
import { displayPhone } from '../customers/CustomersPage.jsx';
import { useEnquiries, useEnquiry } from '../enquiries/enquiriesApi.js';

/** The chosen party's name (customer or enquiry), read from the server. */
function ChosenName({ customerId, enquiryId }) {
  const customer = useCustomer(customerId ?? undefined);
  const enquiry = useEnquiry(customerId ? null : enquiryId);
  const party = customerId ? customer.data : enquiry.data;
  if (!party) return <Loader size="xs" />;
  return (
    <Group gap="xs">
      <Text fw={600}>{party.name}</Text>
      <Text size="sm" c="var(--vs-muted)" className="vs-figures">
        {displayPhone(party.phone)}
      </Text>
      {!customerId && <Badge variant="light">Enquiry</Badge>}
    </Group>
  );
}

/** Customers and open enquiries matching `q` (asked only once something is typed). */
function Matches({ q, onChange }) {
  const customers = useCustomers(q);
  const enquiries = useEnquiries({ view: 'open', q });
  const rows = [
    ...(customers.data?.pages.flatMap((p) => p.items) ?? []).map((c) => ({ kind: 'customer', ...c })),
    ...(enquiries.data?.pages.flatMap((p) => p.items) ?? []).map((e) => ({ kind: 'enquiry', ...e })),
  ].slice(0, 12);
  return (
    <Stack gap={4} mt="xs">
      {rows.map((r) => (
        <UnstyledButton
          key={`${r.kind}:${r.id}`}
          className="vs-row"
          style={{ padding: '6px 8px', borderRadius: 6 }}
          onClick={() => onChange(r.kind === 'customer' ? { customerId: r.id, enquiryId: null } : { customerId: null, enquiryId: r.id })}
        >
          <Group gap="xs">
            <Text fw={600}>{r.name}</Text>
            <Text size="sm" c="var(--vs-muted)" className="vs-figures">
              {displayPhone(r.phone)}
            </Text>
            <Badge variant="light" color={r.kind === 'customer' ? 'indigo' : 'haldi'}>
              {r.kind === 'customer' ? 'Customer' : 'Enquiry'}
            </Badge>
          </Group>
        </UnstyledButton>
      ))}
      {(customers.isPending || enquiries.isPending) && <Loader size="xs" />}
      {rows.length === 0 && !customers.isPending && !enquiries.isPending && <Text size="sm">Nobody matches “{q}”.</Text>}
    </Stack>
  );
}

/** "Who": one search over customers and open enquiries; once chosen, the name with "Change". */
export function PartyPicker({ customerId, enquiryId, onChange }) {
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  if (customerId || enquiryId) {
    return (
      <div role="group" aria-label="Who">
        <Text size="md" fw={500} mb={6}>
          Who
        </Text>
        <Group gap="sm">
          <ChosenName customerId={customerId} enquiryId={enquiryId} />
          <Anchor component="button" type="button" size="sm" onClick={() => onChange({ customerId: null, enquiryId: null })}>
            Change
          </Anchor>
        </Group>
      </div>
    );
  }
  return (
    <div role="group" aria-label="Who">
      <TextInput
        label="Who"
        size="md"
        placeholder="Name or phone"
        leftSection={<IconSearch size={16} aria-hidden="true" />}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      {q && <Matches q={q} onChange={onChange} />}
    </div>
  );
}
