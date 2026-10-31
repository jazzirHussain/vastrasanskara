import { Alert, Button, List, Stack, Text } from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';
import { useVerifyRecords } from './accountsApi.js';

const KINDS = { invoice: 'Bill', credit_note: 'Credit note', receipt: 'Receipt', receipt_voucher: 'Receipt voucher', refund: 'Refund' };

const FIELD_PROBLEMS = {
  paid: 'the amount paid does not match its payments',
  advanceApplied: 'the advance used does not match its payments',
  credited: 'the credited amount does not match its credit notes',
  balance: 'the amount still owed does not add up',
};

/** Everything wrong in a check result, one plain sentence each. */
export function problemsOf(result) {
  const out = [];
  const { firstBreak } = result.audit;
  if (!result.audit.ok && firstBreak) {
    const where = firstBreak.entityType ? ` (${firstBreak.entityType} ${firstBreak.entityId})` : '';
    out.push(
      firstBreak.reason === 'missing_seq'
        ? `An entry is missing from the history at entry ${firstBreak.seq}`
        : `The history has been changed at entry ${firstBreak.seq}${where}`,
    );
  }
  for (const p of result.pdfs.problems) {
    const kind = KINDS[p.type] ?? 'Document';
    out.push(`${kind} ${p.number}: ${p.reason === 'missing' ? 'the PDF is missing' : 'the PDF has changed since it was issued'}`);
  }
  if (result.pdfs.truncated) out.push('More PDF problems were found than are listed here');
  for (const p of result.balances.problems) {
    const what = p.fields.map((f) => FIELD_PROBLEMS[f] ?? 'the figures do not add up');
    out.push(`Bill ${p.number}: ${[...new Set(what)].join('; ')}`);
  }
  if (result.balances.truncated) out.push('More bill problems were found than are listed here');
  return out;
}

const checkedAt = (iso) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

/** "Check records now": the history, stored PDFs and bill balances are checked, and the result said in plain words. */
export function CheckRecordsTab() {
  const verify = useVerifyRecords();
  const result = verify.data;
  const problems = result ? problemsOf(result) : [];

  return (
    <Stack gap="md" maw={720}>
      <Text size="sm" c="var(--vs-muted)">
        This checks that nobody has changed the history of changes, that every printed bill is still exactly as issued, and that each bill’s balance matches its payments. Nothing is changed.
      </Text>
      <Button size="md" loading={verify.isPending} onClick={() => verify.mutate()} style={{ alignSelf: 'flex-start' }}>
        Check records now
      </Button>
      {verify.error && <Alert color="red">{verify.error.message}</Alert>}
      {result && problems.length === 0 && (
        <Alert color="neem" icon={<IconCircleCheck size={20} />}>
          <Text fw={600}>{`All records check out (${result.audit.checked} entries, ${result.pdfs.checked} PDFs)`}</Text>
          {result.pdfs.pending > 0 && <Text size="sm">{`${result.pdfs.pending} PDFs are still being made and were not checked.`}</Text>}
        </Alert>
      )}
      {result && problems.length > 0 && (
        <Alert color="red" title="Something needs a look">
          <List size="sm" spacing={6}>
            {problems.map((p) => (
              <List.Item key={p}>{p}</List.Item>
            ))}
          </List>
          <Text size="sm" mt="sm">
            Do not change anything yourself. Tell whoever looks after the system.
          </Text>
        </Alert>
      )}
      {result && (
        <Text size="sm" c="var(--vs-muted)">
          {`Checked ${checkedAt(result.checkedAt)}`}
        </Text>
      )}
    </Stack>
  );
}
