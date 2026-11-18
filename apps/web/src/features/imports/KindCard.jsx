import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Anchor, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { downloadTemplate } from './importsApi.js';
import { UploadStep } from './UploadStep.jsx';

const shortDay = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** "Done: 412 added on 3 Nov", "Checking…", "Not started"… for a kind's latest import. */
export function lastResult(run) {
  if (!run) return 'Not started';
  switch (run.status) {
    case 'checking':
      return 'Checking…';
    case 'checked':
      return run.fileError ? 'The file needs fixing' : `Checked: ${run.counts.ready} ready to add`;
    case 'importing':
      return `Adding… ${run.progress.done} of ${run.progress.total}`;
    case 'done':
      return `Done: ${run.counts.added} added on ${shortDay(run.finishedAt ?? run.createdAt)}`;
    case 'failed':
      return run.phase === 'commit' ? 'Stopped part way' : 'The file could not be checked';
    default:
      return 'Not started';
  }
}

/** One kind of old record: what it is, its latest result, its template and the upload. */
export function KindCard({ number, kind, run }) {
  const [error, setError] = useState(null);
  const download = (format) => {
    setError(null);
    downloadTemplate(kind.kind, format).catch((e) => setError(e.message));
  };
  return (
    <Paper component="section" aria-label={kind.label} radius="md" p="md" className="vs-panel">
      <Stack gap="sm">
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <Text
            aria-hidden="true"
            fw={700}
            style={{ minWidth: 28, height: 28, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'var(--vs-haldi)', color: 'var(--vs-ink)' }}
          >
            {number}
          </Text>
          <div style={{ minWidth: 0 }}>
            <Text fw={600} fz={18}>
              {kind.label}
            </Text>
            <Text size="sm" c="var(--vs-muted)">
              {kind.help}
            </Text>
            {run && run.status !== 'cancelled' && run.status !== 'expired' ? (
              <Anchor component={Link} to={`/imports/${run.id}`} size="sm" fw={600}>
                {lastResult(run)}
              </Anchor>
            ) : (
              <Text size="sm" fw={600}>
                {lastResult(null)}
              </Text>
            )}
          </div>
        </Group>
        <Group gap="xs" wrap="wrap">
          <Button variant="default" leftSection={<IconDownload size={18} />} onClick={() => download('xlsx')}>
            Download template
          </Button>
          <Button variant="subtle" size="compact-sm" onClick={() => download('csv')}>
            CSV instead
          </Button>
        </Group>
        {error && (
          <Text size="sm" c="var(--vs-kumkum)" role="alert">
            {error}
          </Text>
        )}
        <UploadStep kind={kind} />
      </Stack>
    </Paper>
  );
}
