import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { useConvertEnquiry, usePhoneCheck } from './enquiriesApi.js';

/**
 * "Convert to order": the customer the order is for — the one who already has this phone, or a new
 * customer made from the enquiry — then New order opens filled in.
 */
export function ConvertDialog({ enquiry, onClose }) {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const check = usePhoneCheck(enquiry.phone);
  const convert = useConvertEnquiry(enquiry.id);
  const [someoneElse, setSomeoneElse] = useState(false);
  const known = check.data?.customer ?? null;

  async function go(customerId) {
    try {
      await convert.mutateAsync({ version: enquiry.version, customerId });
      navigate(`/orders/new?enquiry=${enquiry.id}`);
    } catch {
      // The error shows in the dialog.
    }
  }

  return (
    <Modal opened title="Convert to order" centered={!phone} fullScreen={phone} onClose={convert.isPending ? () => {} : onClose}>
      <Stack gap="md">
        {check.isPending && <Loader size="sm" />}
        {check.data && known && (
          <>
            <Text>{known.name} already has this phone. Is this the same person?</Text>
            {someoneElse && (
              <Alert color="yellow">Two customers cannot share a phone. Edit the enquiry phone first, then convert it.</Alert>
            )}
            <Group justify="flex-end" grow={phone}>
              <Button variant="default" size="md" onClick={() => setSomeoneElse(true)} disabled={convert.isPending}>
                No, this is someone else
              </Button>
              <Button size="md" loading={convert.isPending} onClick={() => go(known.id)}>
                Yes, use {known.name}
              </Button>
            </Group>
          </>
        )}
        {check.data && !known && (
          <>
            <Text>We&apos;ll add {enquiry.name} as a customer.</Text>
            <Group justify="flex-end" grow={phone}>
              <Button variant="default" size="md" onClick={onClose} disabled={convert.isPending}>
                Go back
              </Button>
              <Button size="md" loading={convert.isPending} onClick={() => go(null)}>
                Continue
              </Button>
            </Group>
          </>
        )}
        {(check.error || convert.error) && <Alert color="red">{(convert.error ?? check.error).message}</Alert>}
      </Stack>
    </Modal>
  );
}
