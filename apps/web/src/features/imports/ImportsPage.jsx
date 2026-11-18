import { Alert, Loader, Stack, Text } from '@mantine/core';
import { PageHeader } from '../../components/PageHeader.jsx';
import { useImportKinds, useImports } from './importsApi.js';
import { KindCard } from './KindCard.jsx';

/** "Bring in old records": one numbered card per kind, in the order to bring them in. */
export function ImportsPage() {
  const kinds = useImportKinds();
  const runs = useImports();
  // The latest import of each kind that was not left or expired (the list is newest first).
  const latest = new Map();
  for (const run of runs.data?.items ?? []) {
    if (!latest.has(run.kind) && run.status !== 'cancelled' && run.status !== 'expired') latest.set(run.kind, run);
  }
  return (
    <Stack gap={0}>
      <PageHeader title="Bring in old records" />
      <Text mb="md" maw="60ch">
        Bring your old records into the system. Do them in this order.
      </Text>
      <Text size="sm" c="var(--vs-muted)" mb="lg" maw="60ch">
        Download a template, copy your records into it, and upload it. You will see what is ready to add before anything is
        added, and nothing is ever added twice.
      </Text>
      {kinds.isPending && <Loader size="sm" />}
      {kinds.error && <Alert color="red">{kinds.error.message}</Alert>}
      <Stack gap="md">
        {(kinds.data ?? []).map((kind, i) => (
          <KindCard key={kind.kind} number={i + 1} kind={kind} run={latest.get(kind.kind)} />
        ))}
      </Stack>
    </Stack>
  );
}
