import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Group, Loader, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PageHeader } from '../../components/PageHeader.jsx';
import { todayYmd } from '../../components/DateLabel.jsx';
import { useLatestMeasurements } from '../customers/customersApi.js';
import { useSettings } from '../settings/settingsApi.js';
import { CustomerStep } from './new/CustomerStep.jsx';
import { DatesStep, datesProblem } from './new/DatesStep.jsx';
import { GarmentsStep, MAX_GARMENT_LINES, MAX_PIECES, newGarment } from './new/GarmentsStep.jsx';
import { ReviewStep } from './new/ReviewStep.jsx';
import { useCreateOrder, useDesigners } from './ordersApi.js';

export const DRAFT_KEY = 'vs-new-order';
const STEPS = ['Customer', 'Garments', 'Dates', 'Review'];

function freshDraft() {
  return {
    step: 0,
    idempotencyKey: crypto.randomUUID(),
    customer: null,
    designerId: null,
    priority: 'normal',
    garments: [newGarment()],
    pickupDate: '',
    occasionDate: '',
    notes: '',
    expectedBudget: '',
  };
}

// The draft survives a reload or a detour (e.g. to add a customer) until the order is taken.
function loadDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
    if (saved?.garments) return { ...freshDraft(), ...saved, idempotencyKey: saved.idempotencyKey ?? crypto.randomUUID() };
  } catch {
    // An unreadable draft is dropped.
  }
  return freshDraft();
}

const toPaise = (rupees) => Math.round(Number(rupees) * 100);

/** The request body; garments without a chosen set use the customer's latest for that type. */
export function orderBody(draft, latest) {
  return {
    customerId: draft.customer.id,
    designerId: draft.designerId,
    priority: draft.priority,
    expectedBudget: draft.expectedBudget === '' ? null : toPaise(draft.expectedBudget),
    pickupDate: draft.pickupDate,
    occasionDate: draft.occasionDate || null,
    notes: draft.notes.trim(),
    garments: draft.garments.map((g) => ({
      type: g.type,
      description: g.description.trim(),
      fabric: g.fabric.trim(),
      designNotes: g.designNotes.trim(),
      agreedPrice: toPaise(g.price),
      quantity: g.quantity,
      dueDate: g.dueDate || null,
      referenceKeys: g.referenceKeys.map((r) => r.key ?? r),
      materials: (g.materials ?? []).map(({ stockItemId, quantity }) => ({ stockItemId, quantity })),
      measurementId: g.measurementId === undefined ? (latest?.[g.type]?.id ?? null) : g.measurementId,
    })),
  };
}

export const garmentsReady = (garments) =>
  garments.length <= MAX_GARMENT_LINES &&
  garments.every((g) => g.type && g.description.trim() && g.price !== '' && g.price >= 0 && g.quantity >= 1 && g.quantity <= MAX_PIECES);

/** The four steps as a short running stitch: knots for steps done, a ring for this one. */
function StepThread({ step, onPick }) {
  return (
    <ol aria-label="Steps" style={{ display: 'flex', listStyle: 'none', padding: 0, margin: '0 0 28px', gap: 0, flexWrap: 'wrap' }}>
      {STEPS.map((label, i) => {
        const state = i < step ? 'done' : i === step ? 'current' : 'upcoming';
        return (
          <li key={label} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && (
              <svg width="36" height="10" aria-hidden="true" style={{ margin: '0 6px' }}>
                <line x1="0" y1="5" x2="36" y2="5" stroke={i <= step ? 'var(--vs-indigo)' : 'var(--vs-rule)'} strokeWidth="2" strokeDasharray="4 3" />
              </svg>
            )}
            <button
              type="button"
              disabled={i >= step}
              onClick={() => onPick(i)}
              aria-current={state === 'current' ? 'step' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'none',
                border: 0,
                padding: '4px 0',
                font: 'inherit',
                cursor: i < step ? 'pointer' : 'default',
                color: state === 'upcoming' ? 'var(--vs-muted)' : 'var(--vs-ink)',
                fontWeight: state === 'current' ? 600 : 500,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                {state === 'done' && <circle cx="8" cy="8" r="5" fill="var(--vs-indigo)" />}
                {state === 'current' && <circle cx="8" cy="8" r="6" fill="#fff" stroke="var(--vs-indigo)" strokeWidth="2.5" />}
                {state === 'upcoming' && <circle cx="8" cy="8" r="4" fill="#fff" stroke="var(--vs-rule)" strokeWidth="2" />}
              </svg>
              {i + 1} {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function NewOrderPage() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(loadDraft);
  const settings = useSettings();
  const designers = useDesigners();
  const latest = useLatestMeasurements(draft.customer?.id);
  const create = useCreateOrder();
  const today = todayYmd();

  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Private browsing: the draft just is not kept.
    }
  }, [draft]);

  const update = (changes) => {
    create.reset();
    setDraft((d) => ({ ...d, ...changes }));
  };
  const go = (step) => {
    update({ step });
    window.scrollTo?.({ top: 0 });
  };

  function startOver() {
    sessionStorage.removeItem(DRAFT_KEY);
    create.reset();
    setDraft(freshDraft());
  }

  function submit() {
    create.mutate(
      { body: orderBody(draft, latest.data), key: draft.idempotencyKey },
      {
        onSuccess: (order) => {
          sessionStorage.removeItem(DRAFT_KEY);
          notifications.show({ color: 'neem', message: `Order ${order.orderNo} taken` });
          navigate(`/orders/${order.id}`);
        },
      },
    );
  }

  if (settings.isPending) return <Loader />;
  if (settings.error) return <Alert color="red">{settings.error.message}</Alert>;
  const garmentTypes = settings.data.garmentTypes;
  const problem = draft.step >= 2 ? datesProblem(draft, today) : null;
  const canAdvance = [
    Boolean(draft.customer && draft.designerId),
    garmentsReady(draft.garments),
    !problem,
    true,
  ][draft.step];
  const nextLabel = ['Next: garments', 'Next: dates', 'Next: review'][draft.step];

  return (
    <Stack gap={0} maw={880}>
      <PageHeader
        title="Take an order"
        action={
          <Button variant="subtle" color="gray" onClick={startOver}>
            Start over
          </Button>
        }
      />
      <StepThread step={draft.step} onPick={go} />

      {draft.step === 0 && <CustomerStep draft={draft} update={update} designers={designers.data?.items ?? []} />}
      {draft.step === 1 && (
        <GarmentsStep draft={draft} update={update} garmentTypes={garmentTypes} latest={latest.data ?? {}} />
      )}
      {draft.step === 2 && <DatesStep draft={draft} update={update} settings={settings.data} today={today} problem={problem} />}
      {draft.step === 3 && (
        <ReviewStep draft={draft} garmentTypes={garmentTypes} designers={designers.data?.items ?? []} />
      )}
      {create.error && (
        <Alert color="red" mt="lg">
          {create.error.message}
        </Alert>
      )}

      <Group justify="space-between" mt="xl">
        {draft.step > 0 ? (
          <Button variant="default" onClick={() => go(draft.step - 1)}>
            Back
          </Button>
        ) : (
          <span />
        )}
        {draft.step < 3 ? (
          <Button onClick={() => go(draft.step + 1)} disabled={!canAdvance}>
            {nextLabel}
          </Button>
        ) : (
          <Button size="md" onClick={submit} loading={create.isPending}>
            Take order
          </Button>
        )}
      </Group>
    </Stack>
  );
}
