import { Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { messageFor } from '../../lib/errorMessages.js';
import { downloadReport, useReportRuns, useRequestReport, withKey } from './reportsApi.js';

const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const periodText = (p) => p.month ?? (p.from && p.to ? `${p.from} to ${p.to}` : '');

function RunRow({ run }) {
  const again = useRequestReport();
  return (
    <Paper withBorder radius="md" p="sm">
      <Stack gap={4}>
        <Text fw={600} size="sm">
          {run.label}
          {periodText(run.params) ? ` · ${periodText(run.params)}` : ''}
        </Text>
        {(run.status === 'queued' || run.status === 'running') && (
          <Group gap={6}>
            <Loader size="xs" />
            <Text size="sm">Preparing your file…</Text>
          </Group>
        )}
        {run.status === 'done' && (
          <Group justify="space-between" wrap="nowrap">
            <span>
              <Text size="sm">Ready</Text>
              <Text size="xs" c="var(--vs-muted)">
                {sizeText(run.size ?? 0)} · asked by {run.requestedBy?.name ?? 'Automatic'}
              </Text>
            </span>
            <Button size="sm" style={{ minHeight: 44 }} onClick={() => downloadReport(run.id)}>
              Download
            </Button>
          </Group>
        )}
        {run.status === 'failed' && (
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" c="var(--vs-kumkum)">
              Could not be made: {messageFor(run.error?.code, run.error?.message)}
            </Text>
            <Button
              size="sm"
              variant="outline"
              style={{ minHeight: 44, flexShrink: 0 }}
              loading={again.isPending}
              onClick={() => again.mutate(withKey({ kind: run.kind, format: run.format, params: run.params }))}
            >
              Make it again
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

/** The files asked for in the last 90 days, newest first. */
export function RecentFiles() {
  const runs = useReportRuns();
  const items = runs.data?.items ?? [];
  return (
    <section aria-label="Recent files" style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Recent files</h2>
      {runs.isPending && <Loader size="sm" />}
      {runs.data && items.length === 0 && <Text c="var(--vs-muted)">Files you ask for show here. They are kept for 90 days.</Text>}
      <Stack gap="sm">
        {items.map((r) => (
          <RunRow key={r.id} run={r} />
        ))}
      </Stack>
    </section>
  );
}
