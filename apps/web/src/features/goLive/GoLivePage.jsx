import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Paper, Progress, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconCircleDashed } from '@tabler/icons-react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { DateLabel } from '../../components/DateLabel.jsx';
import { useConfirmNumbers, useGoLive, useMarkLive, useSendTestEmail } from './goLiveApi.js';
import { NumberingCheck, SERIES, initialChoice, lastNumber } from './NumberingCheck.jsx';

const STATUS = {
  done: { text: 'Done', color: 'green', Icon: IconCircleCheck },
  warning: { text: 'Check', color: 'yellow', Icon: IconAlertTriangle },
  todo: { text: 'To do', color: 'gray', Icon: IconCircleDashed },
};

function CheckRow({ check, action }) {
  const { text, color, Icon } = STATUS[check.status];
  const link = check.link && !check.link.startsWith('/go-live') && (
    <Anchor component={Link} to={check.link} fw={600} style={{ flexShrink: 0 }}>
      Open
    </Anchor>
  );
  return (
    <li aria-label={check.label} style={{ listStyle: 'none' }}>
      <Paper radius="md" p="md" className="vs-panel">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
          <Group gap="sm" align="flex-start" wrap="nowrap" style={{ minWidth: 0 }}>
            <Icon size={22} color={`var(--mantine-color-${color}-7)`} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ minWidth: 0 }}>
              <Group gap={8}>
                <Text fw={600}>{check.label}</Text>
                <Badge color={color} variant="light" size="sm">
                  {text}
                </Badge>
              </Group>
              <Text size="sm" c="var(--vs-muted)">
                {check.detail}
              </Text>
            </div>
          </Group>
          {action ?? link}
        </Group>
      </Paper>
    </li>
  );
}

function Numbering({ numbering }) {
  const confirm = useConfirmNumbers();
  // Seeded once from the starts the API reports; the owner's edits are kept across refetches.
  const [choices, setChoices] = useState(() => Object.fromEntries(numbering.types.map((t) => [t.type, initialChoice(t)])));
  const types = SERIES.map((s) => ({ ...s, series: numbering.types.find((t) => t.type === s.type) })).filter((s) => s.series);
  if (types.length === 0) return null;
  const series = Object.fromEntries(types.map((s) => [s.type, lastNumber(s.series, choices[s.type] ?? initialChoice(s.series))]));
  const valid = Object.values(series).every((n) => n !== null);
  return (
    <Paper id="numbers" radius="md" p="md" className="vs-panel">
      <Stack gap="md">
        <div>
          <Text fw={600} fz={18}>
            Where bill numbers start
          </Text>
          <Text size="sm" c="var(--vs-muted)">
            GST bills are numbered without gaps. If you already gave out bills this year from a paper book, continue after its last
            number.
          </Text>
        </div>
        {types.map((s) => (
          <NumberingCheck
            key={s.type}
            series={s.series}
            fy={numbering.fy}
            label={s.label}
            noun={s.noun}
            choice={choices[s.type] ?? initialChoice(s.series)}
            onChange={(choice) => setChoices((all) => ({ ...all, [s.type]: choice }))}
          />
        ))}
        {confirm.error && (
          <Alert color="red" role="alert">
            {confirm.error.message}
          </Alert>
        )}
        <Group>
          <Button disabled={!valid} loading={confirm.isPending} onClick={() => confirm.mutate({ series })}>
            Save bill numbers
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

/** "Getting ready to go live": the eight checks, bill numbering and the "We are live" step. */
export function GoLivePage() {
  const checklist = useGoLive();
  const testEmail = useSendTestEmail();
  const markLive = useMarkLive();
  const [asking, setAsking] = useState(false);
  const data = checklist.data;

  if (checklist.isPending) return <Loader size="sm" />;
  if (checklist.error) return <Alert color="red">{checklist.error.message}</Alert>;

  const anyTodo = data.checks.some((c) => c.status === 'todo');
  const anyWarning = data.checks.some((c) => c.status === 'warning');
  const emailButton = (
    <Button variant="default" size="sm" loading={testEmail.isPending} onClick={() => testEmail.mutate()} style={{ flexShrink: 0 }}>
      Send a test email
    </Button>
  );
  return (
    <Stack gap="lg">
      <PageHeader title="Getting ready to go live" />
      {data.liveSince ? (
        <Alert color="green">
          Live since <DateLabel value={data.liveSince} />. Keep the paper form for one more week as a backup.
        </Alert>
      ) : (
        <div>
          <Text fw={600}>
            {data.done} of {data.total} done
          </Text>
          <Progress value={(100 * data.done) / data.total} mt={6} aria-hidden="true" />
        </div>
      )}
      <Stack component="ul" gap="sm" p={0} m={0}>
        {data.checks.map((check) => (
          <CheckRow key={check.key} check={check} action={check.key === 'email' ? emailButton : null} />
        ))}
      </Stack>
      {testEmail.error && (
        <Alert color="red" role="alert">
          {testEmail.error.message}
        </Alert>
      )}
      <Numbering numbering={data.numbering} />
      {!data.liveSince && (
        <div style={{ position: 'sticky', bottom: 'calc(var(--vs-bottom-bar, 0px) + 8px)', zIndex: 5 }}>
          <Paper radius="md" p="sm" className="vs-panel" shadow="sm">
            <Group justify="space-between" wrap="wrap" gap="sm">
              <Text size="sm" c="var(--vs-muted)">
                {anyTodo ? 'Finish the steps marked “To do” first.' : 'Everything needed is ready.'}
              </Text>
              <Button disabled={anyTodo} onClick={() => setAsking(true)}>
                {!anyTodo && anyWarning ? 'Go live anyway' : 'We are live'}
              </Button>
            </Group>
          </Paper>
        </div>
      )}
      <Modal opened={asking} onClose={() => setAsking(false)} title="Start using the system?" centered>
        <Stack gap="md">
          <Text size="sm">Staff will use the system from today. Keep the paper form for one more week as a backup.</Text>
          {markLive.error && (
            <Alert color="red" role="alert">
              {markLive.error.message}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setAsking(false)}>
              Not yet
            </Button>
            <Button loading={markLive.isPending} onClick={() => markLive.mutate(undefined, { onSuccess: () => setAsking(false) })}>
              Yes, we are live
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
