import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Anchor, Button, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconPhoneCall } from '@tabler/icons-react';
import { formatINR } from '@vs/shared/money.js';
import { DateLabel, shortDate } from '../../components/DateLabel.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { displayPhone } from '../customers/CustomersPage.jsx';
import { useSettings } from '../settings/settingsApi.js';
import { interestText } from './EnquiriesPage.jsx';
import { ConvertDialog } from './ConvertDialog.jsx';
import { EnquiryStatus } from './EnquiryStatus.jsx';
import { sourceLabel } from './enquiryForm.js';
import { useEnquiry, useReopenEnquiry } from './enquiriesApi.js';
import { LogCallDialog } from './LogCallDialog.jsx';
import { LostDialog } from './LostDialog.jsx';

function Detail({ label, children }) {
  return (
    <div>
      <Text size="xs" c="var(--vs-muted)">
        {label}
      </Text>
      <Text component="div">{children || '—'}</Text>
    </div>
  );
}

const KIND_PREFIX = { call: 'Called', note: 'Note' };
const logText = (entry) => (KIND_PREFIX[entry.kind] ? `${KIND_PREFIX[entry.kind]} — ${entry.text}` : entry.text);
const atText = (at) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
};

/** One enquiry: who, what they want, when to call, what was said; the next step as a button. */
export function EnquiryPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const enquiry = useEnquiry(id);
  const settings = useSettings();
  const reopen = useReopenEnquiry(id);
  const [dialog, setDialog] = useState(null);
  if (enquiry.isPending) return <Loader />;
  if (enquiry.error) return <Alert color="red">{enquiry.error.message}</Alert>;
  const e = enquiry.data;
  const log = [...e.log].reverse();

  return (
    <Stack gap="lg">
      <PageHeader title={e.name} action={<EnquiryStatus status={e.status} />}>
        <span className="vs-figures">{displayPhone(e.phone)}</span>
      </PageHeader>

      <Group gap="sm">
        <Button component="a" href={`tel:${e.phone}`} size="lg" leftSection={<IconPhoneCall size={20} aria-hidden="true" />}>
          Call
        </Button>
        {e.isOpen && (
          <>
            <Button size="lg" variant="light" onClick={() => setDialog('call')}>
              Log a call
            </Button>
            <Button size="lg" variant="default" component={Link} to={`/appointments/new?enquiryId=${e.id}`}>
              Book appointment
            </Button>
            {e.convertedCustomer ? (
              <Button size="lg" color="neem" onClick={() => navigate(`/orders/new?enquiry=${e.id}`)}>
                Continue to order
              </Button>
            ) : (
              <Button size="lg" color="neem" onClick={() => setDialog('convert')}>
                Convert to order
              </Button>
            )}
            <Button size="lg" variant="subtle" color="kumkum" onClick={() => setDialog('lost')}>
              Not interested
            </Button>
          </>
        )}
        {e.status === 'lost' && (
          <Button size="lg" variant="light" loading={reopen.isPending} onClick={() => reopen.mutate({ version: e.version })}>
            Reopen
          </Button>
        )}
      </Group>
      {reopen.error && <Alert color="red">{reopen.error.message}</Alert>}

      {e.status === 'lost' && <Alert color="gray">Not interested: {e.lostReason}</Alert>}
      {e.isOpen && e.convertedCustomer && <Alert color="green">Customer ready — continue to order</Alert>}
      {e.status === 'converted' && (
        <Alert color="green">
          {e.convertedOrder && (
            <>
              Order{' '}
              <Anchor component={Link} to={`/orders/${e.convertedOrder.id}`}>
                {e.convertedOrder.orderNo ?? 'open'}
              </Anchor>
            </>
          )}
          {e.convertedCustomer && (
            <>
              {' '}for{' '}
              <Anchor component={Link} to={`/customers/${e.convertedCustomer.id}`}>
                {e.convertedCustomer.name ?? 'the customer'}
              </Anchor>
            </>
          )}
        </Alert>
      )}

      <section className="vs-panel" style={{ padding: 20 }} aria-label="Details">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" verticalSpacing="md">
          <Detail label="Interested in">{interestText(e, settings.data?.garmentTypes)}</Detail>
          <Detail label="Budget (rough)">{e.budget ? formatINR(e.budget) : null}</Detail>
          <Detail label="How they heard of us">{sourceLabel(e.source)}</Detail>
          <Detail label="Occasion">{e.occasionDate ? shortDate(e.occasionDate) : null}</Detail>
          <Detail label="Call back on">{e.followUpDate ? <DateLabel ymd={e.followUpDate} /> : e.isOpen ? 'No more calls' : null}</Detail>
          <Detail label="Enquired on">{shortDate(e.enquiryDate)}</Detail>
        </SimpleGrid>
      </section>

      <section aria-label="Activity">
        <Title order={3} mb="sm">
          What happened
        </Title>
        {log.length === 0 ? (
          <Text c="var(--vs-muted)">Nothing yet.</Text>
        ) : (
          <ul aria-label="What happened" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
            {log.map((entry, i) => (
              <li key={`${entry.at}-${i}`}>
                <Text>{logText(entry)}</Text>
                <Text size="xs" c="var(--vs-muted)">
                  {[atText(entry.at), entry.by?.name].filter(Boolean).join(' · ')}
                </Text>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog === 'call' && <LogCallDialog enquiry={e} onClose={() => setDialog(null)} />}
      {dialog === 'lost' && <LostDialog enquiry={e} onClose={() => setDialog(null)} />}
      {dialog === 'convert' && <ConvertDialog enquiry={e} onClose={() => setDialog(null)} />}
    </Stack>
  );
}
