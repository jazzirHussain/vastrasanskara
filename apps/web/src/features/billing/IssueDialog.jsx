import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { formatINR } from '@vs/shared/money.js';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { billErrorMessage } from '../../lib/errorMessages.js';
import { useIssueInvoice } from './billingApi.js';

/**
 * Confirms issuing a draft for `total` paise, then shows the bill number. Mounted once per
 * opening: its Idempotency-Key is made here and sent again on every retry, so pressing
 * "Issue bill" twice (or after a dropped connection) never issues two bills.
 */
export function IssueDialog({ invoiceId, version, total, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [key] = useState(() => crypto.randomUUID());
  const issue = useIssueInvoice(invoiceId);
  const issued = issue.data;

  return (
    <Modal opened onClose={onClose} title={issued ? 'Bill issued' : 'Issue bill'} centered closeOnClickOutside={!issue.isPending}>
      {issued ? (
        <Stack>
          <Text>The bill number is</Text>
          <Text className="vs-figures" fw={700} style={{ fontSize: 28, lineHeight: 1.2 }}>
            {issued.number}
          </Text>
          <Text size="sm" c="var(--vs-muted)">
            You can print it or share it from the bill as soon as the PDF is ready.
          </Text>
          <Button size="md" fullWidth={phone} onClick={onClose} data-autofocus>
            Done
          </Button>
        </Stack>
      ) : (
        <Stack>
          <Text>Issue this bill for {formatINR(total)}? It gets a bill number and cannot be changed after this.</Text>
          {issue.error && <Alert color="red">{billErrorMessage(issue.error)}</Alert>}
          <Group justify="flex-end" gap="sm" style={phone ? { flexDirection: 'column-reverse', alignItems: 'stretch' } : undefined}>
            <Button variant="default" size="md" onClick={onClose} disabled={issue.isPending}>
              Go back
            </Button>
            <Button size="md" loading={issue.isPending} onClick={() => issue.mutate({ version, key })}>
              Issue bill
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
