import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useUpdateUser } from './usersApi.js';
import { RoleCheckboxes } from './roles.jsx';

/** Edits name, roles and active status; only changed fields are sent. */
export function EditUserModal({ user, onClose }) {
  const [form, setForm] = useState({ name: user.name, roles: user.roles, active: user.active });
  const updateUser = useUpdateUser();
  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));

  const changes = {};
  if (form.name !== user.name) changes.name = form.name;
  if (form.roles.join() !== user.roles.join()) changes.roles = form.roles;
  if (form.active !== user.active) changes.active = form.active;

  async function handleSubmit(event) {
    event.preventDefault();
    if (Object.keys(changes).length === 0) return onClose();
    try {
      await updateUser.mutateAsync({ id: user.id, changes });
      onClose();
    } catch {
      // Shown below from updateUser.error.
    }
  }

  return (
    <Modal opened onClose={onClose} title={`Edit ${user.name}`}>
      <form onSubmit={handleSubmit}>
        <Stack>
          {updateUser.error && <Alert color="red">{updateUser.error.message}</Alert>}
          <Text size="sm" c="dimmed">
            {user.email}
          </Text>
          <TextInput label="Name" value={form.name} onChange={(e) => set('name')(e.currentTarget.value)} />
          <RoleCheckboxes value={form.roles} onChange={set('roles')} />
          <Switch label="Active" checked={form.active} onChange={(e) => set('active')(e.currentTarget.checked)} />
          <Text size="sm" c="dimmed">
            Inactive users cannot log in. Changing roles or status logs the user out.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={updateUser.isPending}>
              Save changes
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
