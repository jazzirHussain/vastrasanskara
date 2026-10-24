import { useState } from 'react';
import { Button, Fieldset, Group, NumberInput, Select, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { STAGES } from '@vs/shared/stages.js';

// Stages that take working days (not order taking, pickup readiness or pickup itself).
const WORK_STAGES = STAGES.filter((s) => !['order_taken', 'ready_for_pickup', 'picked_up'].includes(s.key));


/** Sets or clears one stage's days; an empty value removes the key (falls back to the default). */
function withDays(days, stageKey, value) {
  const next = { ...days };
  if (value === '') delete next[stageKey];
  else next[stageKey] = value;
  return next;
}

export function ProductionTab({ values, set, errors }) {
  const { default: defaults, byGarmentType } = values.stageDurations;
  const [newType, setNewType] = useState(null);
  const setDurations = (stageDurations) => set('stageDurations', stageDurations);
  const labelOf = (key) => values.garmentTypes.find((t) => t.key === key)?.label ?? key.replaceAll('_', ' ');
  const available = values.garmentTypes.filter((t) => !byGarmentType[t.key]);

  function addType() {
    if (!newType || byGarmentType[newType]) return;
    setDurations({ ...values.stageDurations, byGarmentType: { ...byGarmentType, [newType]: {} } });
    setNewType(null);
  }

  function removeType(key) {
    const { [key]: _removed, ...rest } = byGarmentType;
    setDurations({ ...values.stageDurations, byGarmentType: rest });
  }

  return (
    <Stack>
      <Title order={4}>Default days per stage</Title>
      <Text size="sm" c="dimmed">
        Used to plan each garment backwards from its due date.
      </Text>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }}>
        {WORK_STAGES.map((stage) => (
          <NumberInput
            key={stage.key}
            label={`${stage.label} (days)`}
            min={0}
            value={defaults[stage.key] ?? ''}
            onChange={(v) => setDurations({ ...values.stageDurations, default: withDays(defaults, stage.key, v) })}
            error={errors[`stageDurations.default.${stage.key}`]}
          />
        ))}
      </SimpleGrid>

      <Title order={4}>Overrides by garment type</Title>
      <Text size="sm" c="dimmed">
        Leave a stage empty to use the default.
      </Text>
      {Object.entries(byGarmentType).map(([type, days]) => (
        <Fieldset key={type} legend={labelOf(type)}>
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }}>
            {WORK_STAGES.map((stage) => (
              <NumberInput
                key={stage.key}
                label={stage.label}
                aria-label={`${labelOf(type)} ${stage.label} (days)`}
                min={0}
                placeholder={String(defaults[stage.key] ?? '')}
                value={days[stage.key] ?? ''}
                onChange={(v) =>
                  setDurations({
                    ...values.stageDurations,
                    byGarmentType: { ...byGarmentType, [type]: withDays(days, stage.key, v) },
                  })
                }
                error={errors[`stageDurations.byGarmentType.${type}.${stage.key}`]}
              />
            ))}
          </SimpleGrid>
          <Group justify="flex-end" mt="sm">
            <Button variant="subtle" color="red" onClick={() => removeType(type)}>
              Remove {labelOf(type)}
            </Button>
          </Group>
        </Fieldset>
      ))}
      <Group align="flex-end">
        <Select
          label="Garment type to override"
          placeholder="Choose a garment type"
          data={available.map((t) => ({ value: t.key, label: t.label }))}
          value={newType}
          onChange={setNewType}
        />
        <Button variant="light" onClick={addType} disabled={!newType}>
          Add override
        </Button>
      </Group>
    </Stack>
  );
}
