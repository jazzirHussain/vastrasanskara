import { useState } from 'react';
import { Alert, Button, Group, Loader, Stack, Switch, TagsInput, Text, TextInput } from '@mantine/core';
import { EmptyState } from '../../components/EmptyState.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { fieldErrors } from '../../lib/fieldErrors.js';
import { changedFields, WorkshopModal } from './WorkshopModal.jsx';
import { useSaveVendor, useVendors } from './workshopApi.js';

function VendorModal({ vendor, onClose }) {
  const [form, setForm] = useState({
    name: vendor?.name ?? '',
    phone: vendor?.phone ?? '',
    gstin: vendor?.gstin ?? '',
    services: vendor?.services ?? [],
    ...(vendor && { active: vendor.active }),
  });
  const save = useSaveVendor();
  const errors = fieldErrors(save.error);
  const set = (field) => (e) => {
    const { value } = e.currentTarget;
    setForm((f) => ({ ...f, [field]: value }));
  };
  // A GSTIN starts with its state code, so the vendor's state follows it.
  const gstin = form.gstin.trim().toUpperCase();

  function submit() {
    if (!vendor) {
      const body = {
        name: form.name,
        ...(form.phone && { phone: form.phone }),
        ...(gstin && { gstin, stateCode: gstin.slice(0, 2) }),
        services: form.services,
      };
      return save.mutateAsync({ body });
    }
    const changes = changedFields({ ...form, gstin }, vendor, ['phone', 'gstin']);
    if (changes.gstin) changes.stateCode = changes.gstin.slice(0, 2);
    if (Object.keys(changes).length === 0) return Promise.resolve();
    return save.mutateAsync({ id: vendor.id, body: { version: vendor.version, ...changes } });
  }

  return (
    <WorkshopModal
      title={vendor ? `Edit ${vendor.name}` : 'Add vendor'}
      save={save}
      submitLabel="Save vendor"
      onSubmit={submit}
      onClose={onClose}
    >
      <TextInput label="Name" value={form.name} onChange={set('name')} error={errors.name} />
      <TagsInput
        label="Services"
        placeholder="Embroidery, dyeing… (Enter after each)"
        value={form.services}
        onChange={(services) => setForm((f) => ({ ...f, services }))}
        error={errors.services}
      />
      <TextInput label="Phone" type="tel" value={form.phone} onChange={set('phone')} error={errors.phone} />
      <TextInput label="GSTIN" value={form.gstin} onChange={set('gstin')} error={errors.gstin ?? errors.stateCode} />
      {vendor && (
        <Switch
          label="Active"
          checked={form.active}
          onChange={(e) => {
            const { checked } = e.currentTarget;
            setForm((f) => ({ ...f, active: checked }));
          }}
        />
      )}
    </WorkshopModal>
  );
}

/** Outside workshops and suppliers that stage work can be sent to. */
export function VendorsTab() {
  const { data, isPending, error } = useVendors();
  const [editing, setEditing] = useState(null);

  return (
    <Stack>
      <Group justify="flex-end">
        <Button onClick={() => setEditing('new')}>Add vendor</Button>
      </Group>
      {isPending && <Loader />}
      {error && <Alert color="red">{error.message}</Alert>}
      {data && data.items.length === 0 && (
        <EmptyState title="No vendors yet" body="Add the workshops you send embroidery, dyeing or other work to." />
      )}
      {data && data.items.length > 0 && (
        <ResponsiveTable
          label="Vendors"
          rows={data.items}
          rowKey={(v) => v.id}
          columns={[
            { key: 'name', header: 'Name', primary: true, render: (v) => <Text fw={600}>{v.name}</Text> },
            { key: 'services', header: 'Services', render: (v) => v.services.join(', ') },
            { key: 'phone', header: 'Phone', render: (v) => v.phone ?? '' },
            { key: 'status', header: 'Status', render: (v) => <StatusBadge status={v.active ? 'active' : 'inactive'} /> },
            {
              key: 'edit',
              header: '',
              align: 'right',
              render: (v) => (
                <Button size="xs" variant="subtle" aria-label={`Edit ${v.name}`} onClick={() => setEditing(v)}>
                  Edit
                </Button>
              ),
            },
          ]}
        />
      )}
      {editing && <VendorModal vendor={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}
