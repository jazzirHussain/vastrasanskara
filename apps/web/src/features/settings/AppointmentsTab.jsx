import { NumberInput, SimpleGrid, Stack, TextInput } from '@mantine/core';

const TYPES = [
  ['consultation', 'Consultation'],
  ['measurement', 'Measurement'],
  ['fitting', 'Fitting'],
  ['pickup', 'Pickup'],
];

export function AppointmentsTab({ values, set, errors }) {
  const durations = values.appointmentDurations;
  return (
    <Stack gap="md">
      <TextInput
        label="Appointments start at"
        description="Free times are offered from here until closing time."
        type="time"
        step={900}
        maw={220}
        value={values.openingTime}
        onChange={(e) => set('openingTime', e.currentTarget.value)}
        error={errors.openingTime}
      />
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      {TYPES.map(([type, label]) => (
        <NumberInput
          key={type}
          label={`${label} (minutes)`}
          min={5}
          max={480}
          step={5}
          value={durations[type]}
          onChange={(v) => set('appointmentDurations', { ...durations, [type]: v })}
          error={errors[`appointmentDurations.${type}`]}
        />
      ))}
    </SimpleGrid>
    </Stack>
  );
}
