import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Anchor, Button, Chip, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { DateLabel } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { PHONE_QUERY, ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { displayPhone } from '../customers/CustomersPage.jsx';
import { useSettings } from '../settings/settingsApi.js';
import { EnquiryStatus } from './EnquiryStatus.jsx';
import { useEnquiries, useFollowUpCount } from './enquiriesApi.js';

const VIEWS = [
  ['open', 'Open'],
  ['new', 'New'],
  ['appointment_booked', 'Appointment booked'],
  ['converted', 'Converted'],
  ['lost', 'Not interested'],
  ['all', 'All'],
];

/** What the caller wants: the garment-type chips' labels, then the details. */
export function interestText(row, garmentTypes = []) {
  const types = row.garmentTypes.map((k) => garmentTypes.find((t) => t.key === k)?.label ?? k);
  return [types.join(', '), row.interest].filter(Boolean).join(' — ');
}

/** "Enquiries": follow-ups due today first, then the other views; search by name or phone. */
export function EnquiriesPage() {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const count = useFollowUpCount();
  const settings = useSettings();
  const [view, setView] = useState(null);
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  // Follow-ups first when any are due, else the open enquiries.
  useEffect(() => {
    if (view === null && count.data) setView(count.data.count > 0 ? 'follow_ups' : 'open');
  }, [view, count.data]);
  const shown = view ?? 'open';
  const enquiries = useEnquiries({ view: shown, q });
  const rows = enquiries.data?.pages.flatMap((p) => p.items) ?? [];
  const garmentTypes = settings.data?.garmentTypes ?? [];
  const newButton = (
    <Button component={Link} to="/enquiries/new" size={phone ? 'lg' : 'sm'} fullWidth={phone}>
      New enquiry
    </Button>
  );

  return (
    <Stack gap={0} pb={phone ? 80 : 0}>
      <PageHeader title="Enquiries" action={!phone && newButton} />
      <Chip.Group multiple={false} value={shown} onChange={setView}>
        <Group gap="xs" mb="md">
          <Chip value="follow_ups" type="radio" variant="outline">
            {`Follow-ups today (${count.data?.count ?? 0})`}
          </Chip>
          {VIEWS.map(([value, label]) => (
            <Chip key={value} value={value} type="radio" variant="outline">
              {label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      <TextInput
        aria-label="Search enquiries"
        placeholder="Search by name or phone"
        leftSection={<IconSearch size={16} aria-hidden="true" />}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        mb="md"
        maw={420}
      />
      {(count.isPending || enquiries.isPending) && <Loader />}
      {enquiries.error && <Alert color="red">{enquiries.error.message}</Alert>}
      {enquiries.data && rows.length === 0 &&
        (shown === 'follow_ups' && !q ? (
          <EmptyState title="No calls due today." body="Enquiries due a call back show here." />
        ) : (
          <EmptyState title="No enquiries here" body={q ? `Nobody's name starts with "${q}" and no phone contains it.` : 'New phone and walk-in enquiries show here.'} />
        ))}
      {rows.length > 0 && (
        <ResponsiveTable
          label="Enquiries"
          rows={rows}
          rowKey={(e) => e.id}
          onRowClick={(e) => navigate(`/enquiries/${e.id}`)}
          columns={[
            { key: 'name', header: 'Name', primary: true, render: (e) => <Text fw={600}>{e.name}</Text> },
            {
              key: 'phone',
              header: 'Phone',
              render: (e) => (
                <Anchor href={`tel:${e.phone}`} className="vs-figures" onClick={(ev) => ev.stopPropagation()}>
                  {displayPhone(e.phone)}
                </Anchor>
              ),
            },
            { key: 'interest', header: 'Interested in', render: (e) => interestText(e, garmentTypes) },
            {
              key: 'call',
              header: 'Call back',
              render: (e) =>
                e.followUpDate ? (
                  <Group gap={6} wrap="nowrap">
                    <DateLabel ymd={e.followUpDate} relative={false} />
                    {e.overdue && (
                      <Text span c="var(--vs-kumkum)" fw={600} size="sm">
                        Overdue
                      </Text>
                    )}
                  </Group>
                ) : (
                  '—'
                ),
            },
            { key: 'status', header: 'Status', render: (e) => <EnquiryStatus status={e.status} /> },
          ]}
        />
      )}
      <LoadMore query={enquiries} />
      {phone && (
        <div style={{ position: 'fixed', left: 16, right: 16, bottom: 'calc(72px + env(safe-area-inset-bottom))', zIndex: 5 }}>
          {newButton}
        </div>
      )}
    </Stack>
  );
}
