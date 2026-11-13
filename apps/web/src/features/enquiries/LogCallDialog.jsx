import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { addDaysYmd } from '@vs/shared/fy.js';
import { todayYmd } from '../../components/DateLabel.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { FollowUpChips } from './FollowUpChips.jsx';
import { useLogCall } from './enquiriesApi.js';

/** "Log a call": what they said and when to call next (or no more calls). */
export function LogCallDialog({ enquiry, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const today = todayYmd();
  const [note, setNote] = useState('');
  const [followUpDate, setFollowUpDate] = useState(addDaysYmd(today, 1));
  const logCall = useLogCall(enquiry.id);
  async function save() {
    try {
      await logCall.mutateAsync({ version: enquiry.version, note: note.trim(), followUpDate });
      onClose();
    } catch {
      // The error shows in the dialog.
    }
  }
  return (
    <Modal opened title="Log a call" centered={!phone} fullScreen={phone} onClose={logCall.isPending ? () => {} : onClose}>
      <Stack gap="md">
        <Textarea label="What did they say?" autosize minRows={2} maxLength={500} value={note} onChange={(e) => setNote(e.currentTarget.value)} data-autofocus />
        <FollowUpChips today={today} value={followUpDate} onChange={setFollowUpDate} allowNone label="Next call" />
        {logCall.error && <Alert color="red">{logCall.error.message}</Alert>}
        <Group justify="flex-end" grow={phone}>
          <Button variant="default" size="md" onClick={onClose} disabled={logCall.isPending}>
            Go back
          </Button>
          <Button size="md" loading={logCall.isPending} onClick={save}>
            Save call
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
