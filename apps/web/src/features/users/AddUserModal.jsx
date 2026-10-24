import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useCreateUser } from './usersApi.js';
import { RoleCheckboxes } from './roles.jsx';

const EMPTY = { name: '', email: '', roles: [] };

/** Creates a user; the server emails them an invite link to set their password. */
export function AddUserModal({ opened, onClose }) {
  const [form, setForm] = useState(EMPTY);
  const createUser = useCreateUser();
  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));

  function close() {
    setForm(EMPTY);
    createUser.reset();
    onClose();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    try {
      await createUser.mutateAsync(form);
      close();
    } catch {
      // Shown below from createUser.error.
    }
  }

  return (
    <Modal opened={opened} onClose={close} title="Add user">
      <form onSubmit={handleSubmit}>
        <Stack>
          {createUser.error && <Alert color="red">{createUser.error.message}</Alert>}
          <TextInput label="Name" value={form.name} onChange={(e) => set('name')(e.currentTarget.value)} />
          <TextInput
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => set('email')(e.currentTarget.value)}
          />
          <RoleCheckboxes value={form.roles} onChange={set('roles')} />
          <Text size="sm" c="dimmed">
            They will get an email with a link to set their password.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={createUser.isPending}>
              Create user
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
