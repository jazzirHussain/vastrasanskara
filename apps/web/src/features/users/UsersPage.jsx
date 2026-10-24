import { useState } from 'react';
import { Alert, Button, Loader, Stack, Text } from '@mantine/core';
import { PageHeader } from '../../components/PageHeader.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { AddUserModal } from './AddUserModal.jsx';
import { EditUserModal } from './EditUserModal.jsx';
import { ROLE_LABELS } from './roles.jsx';
import { useUsers } from './usersApi.js';

export function UsersPage() {
  const { data, isPending, error } = useUsers();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  return (
    <Stack gap={0}>
      <PageHeader title="Users" action={<Button onClick={() => setAdding(true)}>Add user</Button>} />
      {isPending && <Loader />}
      {error && <Alert color="red">{error.message}</Alert>}
      {data && (
        <ResponsiveTable
          label="Users"
          rows={data.items}
          rowKey={(u) => u.id}
          columns={[
            { key: 'name', header: 'Name', primary: true, render: (u) => <Text fw={600}>{u.name}</Text> },
            { key: 'email', header: 'Email', render: (u) => u.email },
            { key: 'roles', header: 'Roles', render: (u) => u.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ') },
            { key: 'status', header: 'Status', render: (u) => <StatusBadge status={u.active ? 'active' : 'inactive'} /> },
            {
              key: 'edit',
              header: '',
              align: 'right',
              render: (u) => (
                <Button size="xs" variant="subtle" aria-label={`Edit ${u.name}`} onClick={() => setEditing(u)}>
                  Edit
                </Button>
              ),
            },
          ]}
        />
      )}
      <AddUserModal opened={adding} onClose={() => setAdding(false)} />
      {editing && <EditUserModal user={editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}
