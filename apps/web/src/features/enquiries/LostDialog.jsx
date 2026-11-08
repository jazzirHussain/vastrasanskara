import { useState } from 'react';
import { Alert, Button, Chip, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { LOST_REASONS } from '@vs/shared/frontOffice.js';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { useMarkLost } from './enquiriesApi.js';

/** "Not interested": why (a chip, or words of their own for "Other"); the enquiry leaves the follow-ups. */
export function LostDialog({ enquiry, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [choice, setChoice] = useState('');
  const [text, setText] = useState('');
  const markLost = useMarkLost(enquiry.id);
  const reason = choice === 'Other' ? text.trim() : choice;
  async function confirm() {
    try {
      await markLost.mutateAsync({ version: enquiry.version, reason });
      onClose();
    } catch {
      // The error shows in the dialog.
    }
  }
  return (
    <Modal opened title="Not interested" centered={!phone} fullScreen={phone} onClose={markLost.isPending ? () => {} : onClose}>
      <Stack gap="md">
        <Text size="sm">{enquiry.name} leaves the follow-ups. You can reopen the enquiry later.</Text>
        <Chip.Group multiple={false} value={choice} onChange={setChoice}>
          <Group gap="xs">
            {LOST_REASONS.map((r) => (
              <Chip key={r} value={r} type="radio" variant="outline">
                {r}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
        {choice === 'Other' && <Textarea label="What happened?" autosize minRows={2} maxLength={200} value={text} onChange={(e) => setText(e.currentTarget.value)} />}
        {markLost.error && <Alert color="red">{markLost.error.message}</Alert>}
        <Group justify="flex-end" grow={phone}>
          <Button variant="default" size="md" onClick={onClose} disabled={markLost.isPending}>
            Go back
          </Button>
          <Button color="kumkum" size="md" disabled={!reason} loading={markLost.isPending} onClick={confirm}>
            Mark not interested
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
