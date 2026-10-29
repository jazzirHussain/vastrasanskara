import { useState } from 'react';
import { Anchor, Group, Stack, Text } from '@mantine/core';
import { istDate, istTime } from '@vs/shared/fy.js';
import { shortDate } from '../../components/DateLabel.jsx';
import { openFile } from '../../lib/upload.js';
import { useGarmentEvents } from './ordersApi.js';
import { stageName } from './stageSteps.js';

const DONE_WORDS = {
  start: 'started',
  complete: 'done',
  qc_pass: 'passed',
  qc_fail: 'failed',
  skip: 'skipped',
  sent_to_vendor: 'sent to a vendor',
  returned_from_vendor: 'back from the vendor',
  rework: 'sent back for rework',
};
const RESOLUTIONS = { refund: 'refund', remake: 'make it again', write_off: 'write off' };

function summary(e) {
  if (e.action === 'picked_up') return 'Handed over to the client';
  if (e.action === 'rejected') return 'Rejected by the client';
  if (e.action === 'alteration') return 'Alteration asked for';
  return `${stageName(e.stage)} ${DONE_WORDS[e.action]}`;
}

function details(e) {
  return [
    e.reworkStage && `Back to ${stageName(e.reworkStage).toLowerCase()}`,
    e.vendor && `${e.vendor.name}${e.dueBackDate ? `, due back ${shortDate(e.dueBackDate)}` : ''}`,
    e.reason,
    e.readyBy && `Ready by ${shortDate(e.readyBy)}`,
    e.resolution && `Decided: ${RESOLUTIONS[e.resolution]}`,
    e.chargeable && 'Chargeable',
  ].filter(Boolean);
}

function when(at) {
  const date = new Date(at);
  return `${shortDate(istDate(date))} ${istTime(date)}`;
}

function Event({ event }) {
  const [fileError, setFileError] = useState(null);
  const people = [event.workers.map((w) => w.name).join(', '), event.by.name, when(event.at)].filter(Boolean).join(' · ');
  return (
    <li aria-label={summary(event)} style={{ borderLeft: '2px solid var(--vs-rule)', paddingLeft: 12 }}>
      <Text size="sm" fw={600}>
        {summary(event)}
      </Text>
      {details(event).map((d) => (
        <Text key={d} size="sm">
          {d}
        </Text>
      ))}
      {event.remarks && (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {event.remarks}
        </Text>
      )}
      {event.photoKeys.length > 0 && (
        <Group gap="sm">
          {event.photoKeys.map((key, i) => (
            <Anchor
              key={key}
              component="button"
              type="button"
              size="sm"
              onClick={() => {
                setFileError(null);
                openFile(key).catch(() => setFileError('This photo could not be opened. Please try again.'));
              }}
            >
              Photo {i + 1}
            </Anchor>
          ))}
        </Group>
      )}
      {fileError && (
        <Text size="sm" c="red" role="alert">
          {fileError}
        </Text>
      )}
      <Text size="xs" c="var(--vs-muted)" className="vs-figures">
        {people}
      </Text>
    </li>
  );
}

/** The garment's production steps, newest first, read when opened. */
export function GarmentHistory({ garmentId }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useGarmentEvents(garmentId, { enabled: open });

  return (
    <Stack gap="xs" align="flex-start">
      <Anchor component="button" type="button" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        History
      </Anchor>
      {open && error && (
        <Text size="sm" c="red">
          {error.message}
        </Text>
      )}
      {open && data && data.items.length === 0 && (
        <Text size="sm" c="var(--vs-muted)">
          No steps recorded yet.
        </Text>
      )}
      {open && data && data.items.length > 0 && (
        <Stack component="ul" gap="sm" m={0} p={0} style={{ listStyle: 'none' }}>
          {[...data.items].reverse().map((e) => (
            <Event key={e.id} event={e} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
