import { useState } from 'react';
import { Button, Fieldset, Group, NumberInput, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { STAGES } from '@vs/shared/stages.js';

// Stages that take working days (not order taking, pickup readiness or pickup itself).
const WORK_STAGES = STAGES.filter((s) => !['order_taken', 'ready_for_pickup', 'picked_up'].includes(s.key));

const toTypeKey = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Sets or clears one stage's days; an empty value removes the key (falls back to the default). */
function withDays(days, stageKey, value) {
  const next = { ...days };
  if (value === '') delete next[stageKey];
  else next[stageKey] = value;
  return next;
}

export function ProductionTab({ values, set, errors }) {
  const { default: defaults, byGarmentType } = values.stageDurations;
  const [newType, setNewType] = useState('');
  const setDurations = (stageDurations) => set('stageDurations', stageDurations);

  function addType() {
    const key = toTypeKey(newType);
    if (!key || byGarmentType[key]) return;
    setDurations({ ...values.stageDurations, byGarmentType: { ...byGarmentType, [key]: {} } });
    setNewType('');
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
        <Fieldset key={type} legend={type.replaceAll('_', ' ')}>
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }}>
            {WORK_STAGES.map((stage) => (
              <NumberInput
                key={stage.key}
                label={stage.label}
                aria-label={`${type} ${stage.label} (days)`}
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
              Remove {type.replaceAll('_', ' ')}
            </Button>
          </Group>
        </Fieldset>
      ))}
      <Group align="flex-end">
        <TextInput
          label="New garment type"
          placeholder="e.g. Bridal lehenga"
          value={newType}
          onChange={(e) => setNewType(e.currentTarget.value)}
        />
        <Button variant="light" onClick={addType}>
          Add garment type
        </Button>
      </Group>
    </Stack>
  );
}
