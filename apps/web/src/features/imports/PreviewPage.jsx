import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Anchor, Button, Group, Loader, Modal, Paper, Stack, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { PageHeader } from '../../components/PageHeader.jsx';
import {
  RECORD_LINKS,
  RECORD_NOUNS,
  downloadProblems,
  downloadTemplate,
  useCancelImport,
  useConfirmImport,
  useImport,
  useResumeImport,
} from './importsApi.js';
import { ProgressCard } from './ProgressCard.jsx';
import { RowList } from './RowList.jsx';

const longDay = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });

function AgainLink() {
  return (
    <Button component={Link} to="/imports" variant="default" style={{ alignSelf: 'flex-start' }}>
      Upload the file again
    </Button>
  );
}

function ProblemsButton({ id }) {
  const [error, setError] = useState(null);
  return (
    <>
      <Button
        variant="default"
        leftSection={<IconDownload size={18} />}
        style={{ alignSelf: 'flex-start' }}
        onClick={() => {
          setError(null);
          downloadProblems(id).catch((e) => setError(e.message));
        }}
      >
        Download rows to fix
      </Button>
      {error && (
        <Text size="sm" c="var(--vs-kumkum)" role="alert">
          {error}
        </Text>
      )}
    </>
  );
}

// The three outcomes of a check, each a filter for the rows below.
function Chips({ counts, value, onChange }) {
  const chips = [
    ['ready', `${counts.ready} ready to add`],
    ['exists', `${counts.exists} already in the system`],
    ['error', `${counts.error} need fixing`],
  ];
  return (
    <Group gap="xs" wrap="wrap" role="group" aria-label="Show rows">
      {chips.map(([key, text]) => (
        <Button
          key={key}
          size="compact-md"
          radius="xl"
          variant={value === key ? 'filled' : 'default'}
          color={key === 'error' ? 'kumkum' : 'indigo'}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {text}
        </Button>
      ))}
    </Group>
  );
}

function Checked({ run }) {
  const confirm = useConfirmImport(run.id);
  const cancel = useCancelImport(run.id);
  const [filter, setFilter] = useState(run.counts.error > 0 ? 'error' : 'ready');
  const [asking, setAsking] = useState(false);
  const noun = RECORD_NOUNS[run.kind] ?? 'records';

  if (run.fileError) {
    return (
      <Stack gap="sm">
        <Alert color="red" role="alert">
          {run.fileError.message}
        </Alert>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconDownload size={18} />} onClick={() => downloadTemplate(run.kind).catch(() => {})}>
            Download template
          </Button>
          <AgainLink />
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap="md" pb={80}>
      {run.sameFileAs?.at && (
        <Alert color="haldi">
          You uploaded this file on {longDay(run.sameFileAs.at)}. Rows already added show as ‘Already in the system’.
        </Alert>
      )}
      {run.unusedColumns.length > 0 && <Text size="sm" c="var(--vs-muted)">These columns were not used: {run.unusedColumns.join(', ')}</Text>}
      <Chips counts={run.counts} value={filter} onChange={setFilter} />
      {run.counts.error > 0 && <ProblemsButton id={run.id} />}
      <RowList id={run.id} status={filter} />
      <Paper
        p="sm"
        className="vs-panel"
        style={{ position: 'sticky', bottom: 'calc(var(--vs-bottom-bar, 0px) + 8px)', zIndex: 5, display: 'flex', gap: 8, flexWrap: 'wrap' }}
      >
        {run.counts.ready > 0 && (
          <Button size="md" onClick={() => setAsking(true)}>
            Add {run.counts.ready} {noun}
          </Button>
        )}
        <Button size="md" variant="subtle" color="kumkum" loading={cancel.isPending} onClick={() => cancel.mutate({ version: run.version })}>
          Cancel this upload
        </Button>
      </Paper>
      {cancel.error && <Alert color="red">{cancel.error.message}</Alert>}
      <Modal opened={asking} onClose={() => setAsking(false)} title={`Add ${run.counts.ready} ${noun}?`} centered>
        <Stack gap="md">
          <Text size="sm">
            Rows that need fixing are left out. Fix them in the downloaded file and upload it again — rows already added will be
            skipped.
          </Text>
          {confirm.error && (
            <Alert color="red" role="alert">
              {confirm.error.message}
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setAsking(false)}>
              Go back
            </Button>
            <Button loading={confirm.isPending} onClick={() => confirm.mutate({ version: run.version }, { onSuccess: () => setAsking(false) })}>
              Add them
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function Done({ run }) {
  const link = RECORD_LINKS[run.kind];
  const already = run.counts.exists + run.counts.skipped;
  return (
    <Stack gap="sm">
      <Alert color="neem">
        Added {run.counts.added} · {already} were already in the system · {run.counts.failed} could not be added
      </Alert>
      {link && (
        <Anchor component={Link} to={link.to} fw={600}>
          {link.label}
        </Anchor>
      )}
      {run.counts.failed + run.counts.error > 0 && <ProblemsButton id={run.id} />}
      {run.counts.failed > 0 && <RowList id={run.id} status="failed" />}
    </Stack>
  );
}

function Stopped({ run }) {
  const resume = useResumeImport(run.id);
  return (
    <Stack gap="sm">
      <Alert color="haldi">Adding stopped part way. Nothing was added twice.</Alert>
      <Text size="sm">
        {run.counts.added} added so far. Continue to add the rest.
      </Text>
      <Button style={{ alignSelf: 'flex-start' }} loading={resume.isPending} onClick={() => resume.mutate({ version: run.version })}>
        Continue adding
      </Button>
      {resume.error && <Alert color="red">{resume.error.message}</Alert>}
    </Stack>
  );
}

/** One uploaded file: being checked, its preview, adding, and the result. */
export function PreviewPage() {
  const { id } = useParams();
  const query = useImport(id);
  const run = query.data;
  return (
    <Stack gap={0}>
      <Anchor component={Link} to="/imports" size="sm" mb="xs">
        ← Bring in old records
      </Anchor>
      <PageHeader title={run?.label ?? 'Bring in old records'}>{run?.fileName}</PageHeader>
      {query.isPending && <Loader size="sm" />}
      {query.error && <Alert color="red">{query.error.message}</Alert>}
      {run?.status === 'checking' && (
        <Group gap="sm">
          <Loader size="sm" />
          <Text>Checking your file…</Text>
        </Group>
      )}
      {run?.status === 'checked' && <Checked key={run.version} run={run} />}
      {run?.status === 'importing' && <ProgressCard run={run} />}
      {run?.status === 'done' && <Done run={run} />}
      {run?.status === 'failed' && run.phase === 'commit' && <Stopped run={run} />}
      {run?.status === 'failed' && run.phase !== 'commit' && (
        <Stack gap="sm">
          <Alert color="red">{run.fileError?.message ?? 'This file could not be checked.'}</Alert>
          <AgainLink />
        </Stack>
      )}
      {run?.status === 'expired' && (
        <Stack gap="sm">
          <Text>This check is more than a week old.</Text>
          <AgainLink />
        </Stack>
      )}
      {run?.status === 'cancelled' && (
        <Stack gap="sm">
          <Text>This upload was left without adding anything.</Text>
          <AgainLink />
        </Stack>
      )}
    </Stack>
  );
}
