import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { PHONE_QUERY } from './ResponsiveTable.jsx';

/**
 * A confirmation that cannot be given without a reason: one sentence saying what will happen
 * (`children`), the reason, then "Yes, …" or "Go back". `pending` locks it while saving;
 * `error` is the plain message of a failed try. `onConfirm(reason)` does the work.
 */
export function ReasonDialog({ title, children, reasonLabel, confirmLabel, keepLabel = 'Go back', onConfirm, onClose, pending = false, error = null }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  return (
    <Modal
      opened
      title={title}
      centered={!phone}
      fullScreen={phone}
      onClose={pending ? () => {} : onClose}
      withCloseButton={!pending}
      closeOnClickOutside={!pending}
      closeOnEscape={!pending}
    >
      <Stack gap="md">
        <Text size="sm">{children}</Text>
        <Textarea label={reasonLabel} autosize minRows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.currentTarget.value)} data-autofocus />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end" grow={phone}>
          <Button variant="default" size="md" onClick={onClose} disabled={pending}>
            {keepLabel}
          </Button>
          <Button color="kumkum" size="md" disabled={!trimmed} loading={pending} onClick={() => onConfirm(trimmed)}>
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
