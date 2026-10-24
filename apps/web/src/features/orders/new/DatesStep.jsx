import { Alert, SimpleGrid, Stack, Text, TextInput, Textarea, Title } from '@mantine/core';
import { durationsFor, planStages, WORK_STAGES } from '@vs/shared/planning.js';
import { STAGES } from '@vs/shared/stages.js';
import { DateLabel } from '../../../components/DateLabel.jsx';
import { StageThread } from '../../../components/StageThread.jsx';

const DAY_MS = 86400000;
const gap = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const labelOf = (key) => STAGES.find((s) => s.key === key).label;

/** What stops the dates step, in words; null when the dates work. */
export function datesProblem(draft, today) {
  if (!draft.pickupDate) return 'Choose a pickup date.';
  if (draft.pickupDate < today) return 'Pickup date cannot be in the past.';
  for (const g of draft.garments) {
    if (g.dueDate && g.dueDate > draft.pickupDate) return 'A garment cannot be due after the pickup date.';
    if (g.dueDate && g.dueDate < today) return 'A garment cannot be due in the past.';
  }
  return null;
}

/** The plan a garment would get, and the stages that get fewer days than usual. */
function preview(garment, draft, settings, today) {
  const durations = durationsFor(settings, garment.type);
  const dueDate = garment.dueDate || draft.pickupDate;
  const { stagePlan, tightSchedule } = planStages({ orderDate: today, dueDate, durations });
  const at = Object.fromEntries(stagePlan.map((s) => [s.stage, s.plannedDate]));
  const shortened = WORK_STAGES.filter((stage, i) => {
    const before = i === 0 ? today : at[WORK_STAGES[i - 1]];
    return gap(before, at[stage]) < durations[stage];
  });
  return { stagePlan, tightSchedule, shortened, dueDate };
}

function shortenedText(stages) {
  const names = stages.map(labelOf);
  if (names.length <= 3) return `${names.join(', ')} get fewer days than usual.`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more stages get fewer days than usual.`;
}

/** Step 3: pickup and occasion dates, with each garment's stage plan previewed live. */
export function DatesStep({ draft, update, settings, today, problem }) {
  const typeLabel = (key) => settings.garmentTypes.find((t) => t.key === key)?.label ?? key;

  return (
    <Stack gap="xl">
      <SimpleGrid cols={{ base: 1, sm: 2 }} maw={560}>
        <TextInput label="Pickup date" type="date" min={today} value={draft.pickupDate} onChange={(e) => update({ pickupDate: e.currentTarget.value })} />
        <TextInput
          label="Occasion date"
          description="Optional, e.g. the wedding"
          type="date"
          value={draft.occasionDate}
          onChange={(e) => update({ occasionDate: e.currentTarget.value })}
        />
      </SimpleGrid>
      {problem && draft.pickupDate && <Alert color="red">{problem}</Alert>}

      {!problem && (
        <section aria-label="Stage plans">
          <Title order={3} mb="sm">
            Stage plan
          </Title>
          <Stack gap="sm">
            {draft.garments.map((g, i) => {
              const plan = preview(g, draft, settings, today);
              return (
                <div key={g.uid} className="vs-panel" style={{ padding: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                    <Text fw={600}>
                      {g.description || `Garment ${i + 1}`}{' '}
                      <Text span c="var(--vs-muted)" fw={400}>
                        {typeLabel(g.type)}
                        {g.quantity > 1 ? `, ${g.quantity} pieces` : ''}
                      </Text>
                    </Text>
                    <Text size="sm">
                      Ready <DateLabel ymd={plan.dueDate} />
                    </Text>
                  </div>
                  <StageThread stagePlan={plan.stagePlan} currentStage="order_taken" status="in_progress" tight={plan.tightSchedule} />
                  {plan.tightSchedule && (
                    <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 6, background: '#FCF5E6', borderLeft: '3px solid var(--vs-haldi)' }}>
                      <Text size="sm" fw={600} c="#875C0C">
                        Tight schedule
                      </Text>
                      <Text size="sm" c="#664609">
                        {shortenedText(plan.shortened)}
                      </Text>
                    </div>
                  )}
                </div>
              );
            })}
          </Stack>
        </section>
      )}

      <Textarea
        label="Notes for the workshop"
        autosize
        minRows={2}
        value={draft.notes}
        onChange={(e) => update({ notes: e.currentTarget.value })}
      />
    </Stack>
  );
}
