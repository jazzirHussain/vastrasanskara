import { Checkbox, Group } from '@mantine/core';

export const ROLE_LABELS = { admin: 'Admin', operations: 'Operations', designer: 'Designer' };

/** Role checkboxes; value is an array of role keys in the order they were ticked. */
export function RoleCheckboxes({ value, onChange, error }) {
  return (
    <Checkbox.Group label="Roles" value={value} onChange={onChange} error={error}>
      <Group mt="xs">
        {Object.entries(ROLE_LABELS).map(([role, label]) => (
          <Checkbox key={role} value={role} label={label} />
        ))}
      </Group>
    </Checkbox.Group>
  );
}
