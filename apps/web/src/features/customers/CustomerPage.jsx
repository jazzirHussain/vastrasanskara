import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Drawer, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { EmptyState } from '../../components/EmptyState.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { useSettings } from '../settings/settingsApi.js';
import { CustomerForm, CUSTOMER_TYPES, SOURCES } from './CustomerForm.jsx';
import { displayPhone } from './CustomersPage.jsx';
import { MeasurementForm } from './MeasurementForm.jsx';
import { MeasurementHistory } from './MeasurementHistory.jsx';
import { useCustomer, useMeasurements, useRecordMeasurement, useUpdateCustomer } from './customersApi.js';
import { CustomerMoney } from '../billing/CustomerMoney.jsx';
import { CustomerOrders } from './CustomerOrders.jsx';
import { PartyAppointments } from '../appointments/PartyAppointments.jsx';

const CHANNEL_LABELS = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
const labelOf = (list, value) => list.find((x) => x.value === value)?.label ?? value;

function Detail({ label, children }) {
  return (
    <div>
      <Text size="xs" c="var(--vs-muted)">
        {label}
      </Text>
      <Text>{children || '—'}</Text>
    </div>
  );
}

function consentText(c) {
  const channels = Object.keys(CHANNEL_LABELS).filter((k) => c.consent[k]);
  return channels.length ? channels.map((k) => CHANNEL_LABELS[k]).join(', ') : 'No messages';
}

export function CustomerPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const customer = useCustomer(id);
  const measurements = useMeasurements(id);
  const settings = useSettings();
  const update = useUpdateCustomer(id);
  const record = useRecordMeasurement(id);
  const [editing, setEditing] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const garmentTypes = settings.data?.garmentTypes ?? [];

  if (customer.isPending) return <Loader />;
  if (customer.error) return <Alert color="red">{customer.error.message}</Alert>;
  const c = customer.data;
  const address = [c.billingAddress.line1, c.billingAddress.line2, c.billingAddress.city, c.billingAddress.pincode].filter(Boolean).join(', ');

  return (
    <Stack gap={0}>
      <PageHeader
        title={c.name}
        action={
          <Group gap="xs">
            {can('customers.write') && (
              <Button variant="default" onClick={() => setEditing(true)}>
                Edit details
              </Button>
            )}
            {can('measurements.write') && <Button onClick={() => setMeasuring(true)}>Take measurements</Button>}
          </Group>
        }
      >
        <span className="vs-figures">{displayPhone(c.phone)}</span>
      </PageHeader>

      <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'start' }}>
        <section className="vs-panel" style={{ padding: 20 }} aria-label="Details">
          <Title order={3} mb="md">
            Details
          </Title>
          <SimpleGrid cols={2} spacing="md" verticalSpacing="md">
            <Detail label="Type">{labelOf(CUSTOMER_TYPES, c.type)}</Detail>
            <Detail label="Email">{c.email}</Detail>
            <Detail label="GSTIN">{c.gstin}</Detail>
            <Detail label="State code">{c.stateCode}</Detail>
            <Detail label="Billing address">{address}</Detail>
            <Detail label="How they found us">{labelOf(SOURCES, c.source)}</Detail>
            <Detail label="Messages">{consentText(c)}</Detail>
            <Detail label="How they agreed">{c.consentNote}</Detail>
          </SimpleGrid>
        </section>

        <section aria-label="Measurements">
          <Title order={3} mb="md">
            Measurements
          </Title>
          {measurements.isPending && <Loader size="sm" />}
          {measurements.data?.items.length === 0 && (
            <EmptyState title="No measurements yet" body="Take measurements once, and new orders fill them in for you." />
          )}
          {measurements.data?.items.length > 0 && <MeasurementHistory items={measurements.data.items} garmentTypes={garmentTypes} />}
        </section>
      </div>

      <CustomerMoney customer={c} />

      <CustomerOrders customerId={c.id} />

      {can('appointments.own') && <PartyAppointments customerId={c.id} />}

      <Drawer opened={editing} onClose={() => { setEditing(false); update.reset(); }} title="Edit details" position="right" size="md">
        {editing && <CustomerForm customer={c} mutation={update} onSaved={() => setEditing(false)} />}
      </Drawer>
      <Drawer opened={measuring} onClose={() => { setMeasuring(false); record.reset(); }} title="Take measurements" position="right" size="md">
        {measuring && <MeasurementForm garmentTypes={garmentTypes} mutation={record} onSaved={() => setMeasuring(false)} />}
      </Drawer>
    </Stack>
  );
}
