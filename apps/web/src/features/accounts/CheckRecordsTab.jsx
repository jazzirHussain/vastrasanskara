import { Alert, Button, List, Stack, Text } from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';
import { useLatestCheck, useStartCheck } from './accountsApi.js';

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
    // The document's number when the entry is a bill, receipt or the like; never a raw id.
    const where = firstBreak.number ? ` (${KINDS[firstBreak.entityType] ?? 'Document'} ${firstBreak.number})` : '';
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
  // Checks run before bill photos were checked have no photos section.
  for (const p of result.photos?.problems ?? []) {
    out.push(`${p.label}: ${p.reason === 'missing' ? 'it is missing' : 'it has changed since it was saved'}`);
  }
  if (result.photos?.truncated) out.push('More bill photo problems were found than are listed here');
  for (const p of result.balances.problems) {
    const what = p.fields.map((f) => FIELD_PROBLEMS[f] ?? 'the figures do not add up');
    out.push(`Bill ${p.number}: ${[...new Set(what)].join('; ')}`);
  }
  if (result.balances.truncated) out.push('More bill problems were found than are listed here');
  return out;
}

const checkedAt = (iso) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

/**
 * "Check records now": starts a check of the history, stored PDFs and bill balances (it runs in
 * the background), waits for it and says the result in plain words.
 */
export function CheckRecordsTab() {
  const latest = useLatestCheck();
  const start = useStartCheck();
  const run = latest.data?.run ?? null;
  const running = run?.status === 'running';
  const result = run?.status === 'done' ? run.result : null;
  const problems = result ? problemsOf(result) : [];
  const error = start.error ?? latest.error;

  return (
    <Stack gap="md" maw={720}>
      <Text size="sm" c="var(--vs-muted)">
        This checks that nobody has changed the history of changes, that every printed bill is still exactly as issued, and that each bill’s balance matches its payments. Nothing is changed.
      </Text>
      <Button size="md" loading={start.isPending || running} onClick={() => start.mutate()} style={{ alignSelf: 'flex-start' }}>
        Check records now
      </Button>
      {running && <Text size="sm">Checking your records… this can take a minute</Text>}
      {error && <Alert color="red">{error.message}</Alert>}
      {run?.status === 'failed' && <Alert color="red">The check could not finish. Please try again.</Alert>}
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
