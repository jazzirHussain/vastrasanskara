import { useState } from 'react';
import { Alert, Badge, Button, Group, Loader, Stack, Table, Title } from '@mantine/core';
import { AddUserModal } from './AddUserModal.jsx';
import { EditUserModal } from './EditUserModal.jsx';
import { ROLE_LABELS } from './roles.jsx';
import { useUsers } from './usersApi.js';

export function UsersPage() {
  const { data, isPending, error } = useUsers();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Users</Title>
        <Button onClick={() => setAdding(true)}>Add user</Button>
      </Group>
      {isPending && <Loader />}
      {error && <Alert color="red">{error.message}</Alert>}
      {data && (
        <Table.ScrollContainer minWidth={560}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Email</Table.Th>
                <Table.Th>Roles</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.items.map((user) => (
                <Table.Tr key={user.id}>
                  <Table.Td>{user.name}</Table.Td>
                  <Table.Td>{user.email}</Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {user.roles.map((role) => (
                        <Badge key={role} variant="light">
                          {ROLE_LABELS[role] ?? role}
                        </Badge>
                      ))}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={user.active ? 'green' : 'gray'}>{user.active ? 'Active' : 'Inactive'}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Button size="xs" variant="subtle" aria-label={`Edit ${user.name}`} onClick={() => setEditing(user)}>
                      Edit
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <AddUserModal opened={adding} onClose={() => setAdding(false)} />
      {editing && <EditUserModal user={editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}
