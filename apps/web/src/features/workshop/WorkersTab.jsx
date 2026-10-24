import { useState } from 'react';
import { Alert, Button, Group, Loader, Stack, Switch, Text, TextInput } from '@mantine/core';
import { EmptyState } from '../../components/EmptyState.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { fieldErrors } from '../../lib/fieldErrors.js';
import { changedFields, WorkshopModal } from './WorkshopModal.jsx';
import { useSaveWorker, useWorkers } from './workshopApi.js';

function WorkerModal({ worker, onClose }) {
  const [form, setForm] = useState({
    name: worker?.name ?? '',
    skill: worker?.skill ?? '',
    phone: worker?.phone ?? '',
    ...(worker && { active: worker.active }),
  });
  const save = useSaveWorker();
  const errors = fieldErrors(save.error);
  const set = (field) => (e) => {
    const { value } = e.currentTarget;
    setForm((f) => ({ ...f, [field]: value }));
  };

  function submit() {
    if (!worker) {
      const body = { name: form.name, ...(form.skill && { skill: form.skill }), ...(form.phone && { phone: form.phone }) };
      return save.mutateAsync({ body });
    }
    const changes = changedFields(form, worker, ['phone']);
    if (Object.keys(changes).length === 0) return Promise.resolve();
    return save.mutateAsync({ id: worker.id, body: { version: worker.version, ...changes } });
  }

  return (
    <WorkshopModal
      title={worker ? `Edit ${worker.name}` : 'Add worker'}
      save={save}
      submitLabel="Save worker"
      onSubmit={submit}
      onClose={onClose}
    >
      <TextInput label="Name" value={form.name} onChange={set('name')} error={errors.name} />
      <TextInput label="Skill" placeholder="Master tailor, handwork, cutting…" value={form.skill} onChange={set('skill')} error={errors.skill} />
      <TextInput label="Phone" type="tel" value={form.phone} onChange={set('phone')} error={errors.phone} />
      {worker && (
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

/** Tailors, masters and artisans: who can be named on a stage. */
export function WorkersTab() {
  const { data, isPending, error } = useWorkers();
  const [editing, setEditing] = useState(null);

  return (
    <Stack>
      <Group justify="flex-end">
        <Button onClick={() => setEditing('new')}>Add worker</Button>
      </Group>
      {isPending && <Loader />}
      {error && <Alert color="red">{error.message}</Alert>}
      {data && data.items.length === 0 && (
        <EmptyState title="No workers yet" body="Add the tailors and artisans who work on garments." />
      )}
      {data && data.items.length > 0 && (
        <ResponsiveTable
          label="Workers"
          rows={data.items}
          rowKey={(w) => w.id}
          columns={[
            { key: 'name', header: 'Name', primary: true, render: (w) => <Text fw={600}>{w.name}</Text> },
            { key: 'skill', header: 'Skill', render: (w) => w.skill },
            { key: 'phone', header: 'Phone', render: (w) => w.phone ?? '' },
            { key: 'status', header: 'Status', render: (w) => <StatusBadge status={w.active ? 'active' : 'inactive'} /> },
            {
              key: 'edit',
              header: '',
              align: 'right',
              render: (w) => (
                <Button size="xs" variant="subtle" aria-label={`Edit ${w.name}`} onClick={() => setEditing(w)}>
                  Edit
                </Button>
              ),
            },
          ]}
        />
      )}
      {editing && <WorkerModal worker={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}
