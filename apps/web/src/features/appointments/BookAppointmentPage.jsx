import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Anchor, Button, Checkbox, Chip, Group, Loader, NumberInput, Stack, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { appointmentWhen, APPOINTMENT_TYPE_LABELS, APPOINTMENT_TYPES } from '@vs/shared/frontOffice.js';
import { atIstTime } from '@vs/shared/fy.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { todayYmd } from '../../components/DateLabel.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { apiFetch } from '../../lib/api.js';
import { useDesigners } from '../orders/ordersApi.js';
import { useSettings } from '../settings/settingsApi.js';
import { useAppointments, useBookAppointment, useDay } from './appointmentsApi.js';
import { bookingBody, bookingDefaults, dayChoices, timeChoices } from './bookingForm.js';
import { PartyPicker } from './PartyPicker.jsx';
import { TimeChips } from './TimeChips.jsx';

const MAY_BE_SAVED = 'This appointment may already be booked. Check Appointments before trying again.';
const BOOK_ERRORS = {
  SLOT_TAKEN: 'That time was just booked. Pick another time.',
  IDEMPOTENCY_IN_PROGRESS: MAY_BE_SAVED,
  IDEMPOTENCY_KEY_REUSED: MAY_BE_SAVED,
};
const LIVE = new Set(['in_progress', 'ready']);

/** The order's garments still being made, as checkboxes (a fitting may name them). */
function GarmentChoices({ orderId, value, onChange }) {
  const order = useQuery({ queryKey: ['orders', orderId], queryFn: () => apiFetch(`/v1/orders/${orderId}`), enabled: Boolean(orderId) });
  const garments = (order.data?.garments ?? []).filter((g) => LIVE.has(g.status));
  if (!orderId) return null;
  if (order.isPending) return <Loader size="xs" />;
  if (!garments.length) return null;
  return (
    <Checkbox.Group label="Garments to try" value={value} onChange={onChange}>
      <Stack gap="xs" mt="xs">
        {garments.map((g) => (
          <Checkbox key={g.id} value={g.id} label={`${g.garmentNo} · ${g.description}`} />
        ))}
      </Stack>
    </Checkbox.Group>
  );
}

function BookingForm({ settings, designers }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const today = todayYmd();
  // Made when the page opens and sent on every retry: a double tap books once.
  const [key] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState(() => bookingDefaults(params, { settings, today }));
  const [changingLength, setChangingLength] = useState(false);
  const [pickingDate, setPickingDate] = useState(false);
  const book = useBookAppointment();
  const edit = (patch) => {
    book.reset();
    setForm((f) => ({ ...f, ...patch }));
  };

  // The designer this client saw last, when none was given.
  const party = form.customerId ? { customerId: form.customerId } : form.enquiryId ? { enquiryId: form.enquiryId } : null;
  const history = useAppointments(party ?? {}, { enabled: Boolean(party) && !form.designerId });
  useEffect(() => {
    const last = history.data?.pages.flatMap((p) => p.items).at(-1);
    if (!form.designerId && last) setForm((f) => (f.designerId ? f : { ...f, designerId: last.designer.id }));
  }, [history.data, form.designerId]);

  const day = useDay(form.date);
  const choices = timeChoices(day.data?.date === form.date ? day.data : null, {
    designerId: form.designerId,
    minutes: form.minutes,
    settings,
    now: new Date(),
  });
  const ready = Boolean(party && form.designerId && form.date && form.time && form.minutes);
  const when = form.time ? appointmentWhen(atIstTime(form.date, form.time)) : null;

  const saving = useRef(false);
  async function save() {
    if (saving.current) return;
    saving.current = true;
    try {
      await book.mutateAsync({ body: bookingBody(form), key });
      notifications.show({ color: 'neem', message: 'Booked' });
      navigate(`/appointments?date=${form.date}`);
    } catch (err) {
      saving.current = false;
      if (err?.code === 'SLOT_TAKEN') {
        day.refetch();
        setForm((f) => ({ ...f, time: '' }));
      }
    }
  }

  const days = dayChoices(today);
  const onChip = days.some((d) => d.date === form.date);
  const showFitting = form.type === 'fitting' && form.customerId;

  return (
    <Stack gap="lg" pb="xl">
      <PageHeader title="Book appointment" />
      <PartyPicker customerId={form.customerId} enquiryId={form.enquiryId} onChange={(p) => edit({ ...p, garmentIds: [], orderId: null })} />

      <div role="group" aria-label="What for">
        <Text size="md" fw={500} mb={6}>
          What for
        </Text>
        <Chip.Group multiple={false} value={form.type} onChange={(type) => edit({ type, minutes: settings.appointmentDurations[type] })}>
          <Group gap="xs">
            {APPOINTMENT_TYPES.map((t) => (
              <Chip key={t} value={t} type="radio" size="md" variant="outline">
                {APPOINTMENT_TYPE_LABELS[t]}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </div>

      <div role="group" aria-label="Designer">
        <Text size="md" fw={500} mb={6}>
          Designer
        </Text>
        <Chip.Group multiple={false} value={form.designerId ?? ''} onChange={(designerId) => edit({ designerId })}>
          <Group gap="xs">
            {designers.map((d) => (
              <Chip key={d.id} value={d.id} type="radio" size="md" variant="outline">
                {d.name}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </div>

      <div role="group" aria-label="Day">
        <Text size="md" fw={500} mb={6}>
          Day
        </Text>
        <Chip.Group multiple={false} value={onChip ? form.date : ''} onChange={(date) => { setPickingDate(false); edit({ date, time: '' }); }}>
          <Group gap="xs">
            {days.map((d) => (
              <Chip key={d.date} value={d.date} type="radio" size="md" variant="outline">
                {d.label}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
        {pickingDate || !onChip ? (
          <TextInput mt="xs" type="date" size="md" label="Date" min={today} value={form.date} onChange={(e) => e.currentTarget.value && edit({ date: e.currentTarget.value, time: '' })} />
        ) : (
          <Anchor component="button" type="button" size="sm" mt="xs" onClick={() => setPickingDate(true)}>
            Pick a date
          </Anchor>
        )}
      </div>

      {form.designerId ? (
        <TimeChips key={`${form.designerId}:${form.date}`} choices={choices} value={form.time} loading={day.isPending} onChange={(time) => edit({ time })} />
      ) : (
        <Text size="sm" c="var(--vs-muted)">
          Choose a designer to see the free times.
        </Text>
      )}

      <div>
        <Text size="md" fw={500} mb={6}>
          How long
        </Text>
        {changingLength ? (
          <NumberInput aria-label="Minutes" size="md" min={5} max={480} step={15} value={form.minutes} onChange={(v) => edit({ minutes: Number(v) || 0 })} maw={160} />
        ) : (
          <Group gap="xs">
            <Text>{form.minutes} minutes</Text>
            <Anchor component="button" type="button" size="sm" onClick={() => setChangingLength(true)}>
              Change
            </Anchor>
          </Group>
        )}
      </div>

      {showFitting && <GarmentChoices orderId={form.orderId} value={form.garmentIds} onChange={(garmentIds) => edit({ garmentIds })} />}

      <TextInput label="Note (optional)" size="md" maxLength={300} value={form.note} onChange={(e) => edit({ note: e.currentTarget.value })} />

      <Stack
        gap="xs"
        style={{
          position: 'sticky',
          bottom: phone ? 'calc(64px + env(safe-area-inset-bottom))' : 0,
          zIndex: 5,
          background: 'var(--mantine-color-body)',
          padding: '12px 0',
          borderTop: '1px solid var(--vs-rule)',
        }}
      >
        {book.error && <Alert color="red">{BOOK_ERRORS[book.error.code] ?? book.error.message}</Alert>}
        <Button size="xl" fullWidth disabled={!ready} loading={book.isPending} onClick={save}>
          {when ? `Book for ${when}` : 'Book'}
        </Button>
      </Stack>
    </Stack>
  );
}

/** "Book appointment" (/appointments/new): who, what for, designer, day and a free time, on one screen. */
export function BookAppointmentPage() {
  const location = useLocation();
  const settings = useSettings();
  const designers = useDesigners();
  if (settings.isPending || designers.isPending) return <Loader />;
  if (settings.error || designers.error) return <Alert color="red">{(settings.error ?? designers.error).message}</Alert>;
  return <BookingForm key={location.key} settings={settings.data} designers={designers.data.items} />;
}
