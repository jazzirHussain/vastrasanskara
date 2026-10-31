import { useState } from 'react';
import { Alert, Button, Group, Loader, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { financialYear, istDate } from '@vs/shared/fy.js';
import { shortDate } from '../../components/DateLabel.jsx';
import { ReasonDialog } from '../../components/ReasonDialog.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { monthLabel } from '../../lib/dates.js';
import { useLockMonth, usePeriods, useUnlockMonth } from './accountsApi.js';

/** This financial year and the five before it, newest first: '2026-27', '2025-26' … */
function yearOptions() {
  const { startYear } = financialYear(new Date());
  return Array.from({ length: 6 }, (_, i) => {
    const y = startYear - i;
    return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  });
}

function LockDialog({ month, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const lock = useLockMonth();
  const [note, setNote] = useState('');
  const label = monthLabel(month);
  return (
    <Modal
      opened
      title={`Lock ${label}?`}
      centered={!phone}
      fullScreen={phone}
      onClose={lock.isPending ? () => {} : onClose}
      withCloseButton={!lock.isPending}
      closeOnClickOutside={!lock.isPending}
      closeOnEscape={!lock.isPending}
    >
      <Stack gap="md">
        <Text size="sm">{`Lock ${label}? Do this after you file GSTR-1. No bills, payments or refunds can be added, changed or cancelled in a locked month.`}</Text>
        <Textarea label="Note (optional)" autosize minRows={2} maxLength={300} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        {lock.error && <Alert color="red">{lock.error.message}</Alert>}
        <Group justify="flex-end" grow={phone}>
          <Button variant="default" size="md" onClick={onClose} disabled={lock.isPending}>
            Go back
          </Button>
          <Button size="md" loading={lock.isPending} onClick={() => lock.mutate({ month, note: note.trim() }, { onSuccess: onClose })}>
            {`Lock ${label}`}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function UnlockDialog({ month, onClose }) {
  const unlock = useUnlockMonth();
  const label = monthLabel(month);
  return (
    <ReasonDialog
      title={`Unlock ${label}?`}
      reasonLabel="Why is it being unlocked?"
      confirmLabel={`Unlock ${label}`}
      pending={unlock.isPending}
      error={unlock.error ? unlock.error.message : null}
      onClose={onClose}
      onConfirm={(reason) => unlock.mutate({ month, reason }, { onSuccess: onClose })}
    >
      Bills, payments and refunds dated in {label} can be added, changed or cancelled again until you lock it once more.
    </ReasonDialog>
  );
}

function MonthRow({ m, onLock, onUnlock }) {
  const lockedOn = m.lockedAt ? shortDate(istDate(new Date(m.lockedAt))) : null;
  return (
    <div className="vs-stack-row" data-month={m.month} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0, flex: '1 1 220px' }}>
        <Group gap="sm" wrap="wrap">
          <Text fw={600}>{monthLabel(m.month)}</Text>
          <StatusBadge status={m.locked ? 'completed' : 'inactive'} label={m.locked ? 'Locked' : 'Open'} />
        </Group>
        {m.locked && (
          <Text size="sm" c="var(--vs-muted)">
            {`Locked${m.lockedBy?.name ? ` by ${m.lockedBy.name}` : ''}${lockedOn ? ` on ${lockedOn}` : ''}`}
          </Text>
        )}
        {m.locked && m.note && (
          <Text size="sm" c="var(--vs-muted)">
            {m.note}
          </Text>
        )}
      </div>
      {m.locked ? (
        <Button variant="default" size="md" onClick={() => onUnlock(m.month)}>
          Unlock
        </Button>
      ) : m.canLock ? (
        <Button size="md" onClick={() => onLock(m.month)}>
          Lock month
        </Button>
      ) : (
        <Text size="sm" c="var(--vs-muted)">
          You can lock a month after it ends
        </Text>
      )}
    </div>
  );
}

/** The twelve months of a financial year: locked or open, who locked them, and the buttons to lock or unlock. */
export function MonthLocksTab() {
  const years = yearOptions();
  const [fy, setFy] = useState(years[0]);
  const periods = usePeriods(fy === years[0] ? undefined : fy);
  const [locking, setLocking] = useState(null);
  const [unlocking, setUnlocking] = useState(null);

  return (
    <Stack gap="md">
      <Text size="sm" c="var(--vs-muted)">
        Lock a month once you have filed its GST return, so nothing in it can change by mistake.
      </Text>
      <Select label="Financial year" data={years} value={fy} onChange={(v) => v && setFy(v)} allowDeselect={false} maw={220} />
      {periods.isPending && <Loader />}
      {periods.error && <Alert color="red">{periods.error.message}</Alert>}
      {periods.data && (
        <div className="vs-stack" role="list" aria-label="Months">
          {periods.data.months.map((m) => (
            <MonthRow key={m.month} m={m} onLock={setLocking} onUnlock={setUnlocking} />
          ))}
        </div>
      )}
      {locking && <LockDialog month={locking} onClose={() => setLocking(null)} />}
      {unlocking && <UnlockDialog month={unlocking} onClose={() => setUnlocking(null)} />}
    </Stack>
  );
}
