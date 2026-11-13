import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { appointmentWhen } from '@vs/shared/frontOffice.js';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { useCancelAppointment } from './appointmentsApi.js';

/** "Cancel appointment": an optional reason; the client and the designer are told. */
export function CancelDialog({ appointment: a, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [reason, setReason] = useState('');
  const cancel = useCancelAppointment(a.id);
  const who = a.customer ?? a.enquiry;
  async function confirm() {
    try {
      await cancel.mutateAsync({ version: a.version, reason: reason.trim() });
      onClose();
    } catch {
      // The error shows in the dialog.
    }
  }
  return (
    <Modal opened title="Cancel appointment" centered={!phone} fullScreen={phone} onClose={cancel.isPending ? () => {} : onClose}>
      <Stack gap="md">
        <Text>
          {who?.name}, {appointmentWhen(new Date(a.start))}.
        </Text>
        <Text size="sm">The client and designer will be told.</Text>
        <Textarea label="Reason (optional)" autosize minRows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        {cancel.error && <Alert color="red">{cancel.error.message}</Alert>}
        <Group justify="flex-end" grow={phone}>
          <Button variant="default" size="md" onClick={onClose} disabled={cancel.isPending}>
            Go back
          </Button>
          <Button color="kumkum" size="md" loading={cancel.isPending} onClick={confirm}>
            Yes, cancel it
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
