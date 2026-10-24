import { Alert, Button, Group, Modal, Stack } from '@mantine/core';

/**
 * The add/edit dialog of a worker or vendor. `save` is the useSave mutation; on a conflict it
 * offers Reload (the list is read again and the dialog closes).
 */
export function WorkshopModal({ title, save, submitLabel, onSubmit, onClose, children }) {
  const conflict = save.error?.code === 'CONFLICT';

  async function handleSubmit(event) {
    event.preventDefault();
    try {
      await onSubmit();
      onClose();
    } catch {
      // Shown below from save.error.
    }
  }

  return (
    <Modal opened onClose={onClose} title={title}>
      <form onSubmit={handleSubmit}>
        <Stack>
          {save.error && (
            <Alert color="red">
              <Group justify="space-between">
                {save.error.message}
                {conflict && (
                  <Button
                    size="xs"
                    variant="white"
                    onClick={() => {
                      save.refresh();
                      onClose();
                    }}
                  >
                    Reload
                  </Button>
                )}
              </Group>
            </Alert>
          )}
          {children}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {submitLabel}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** The fields of `form` that differ from `original`; a blank `nullable` field becomes null. */
export function changedFields(form, original, nullable = []) {
  const changes = {};
  for (const [field, value] of Object.entries(form)) {
    const next = value === '' && nullable.includes(field) ? null : value;
    if (JSON.stringify(next) !== JSON.stringify(original[field] ?? null)) changes[field] = next;
  }
  return changes;
}
