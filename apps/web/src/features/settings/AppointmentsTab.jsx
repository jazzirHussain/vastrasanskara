import { NumberInput, SimpleGrid } from '@mantine/core';

const TYPES = [
  ['consultation', 'Consultation'],
  ['measurement', 'Measurement'],
  ['fitting', 'Fitting'],
  ['pickup', 'Pickup'],
];

export function AppointmentsTab({ values, set, errors }) {
  const durations = values.appointmentDurations;
  return (
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
  );
}
