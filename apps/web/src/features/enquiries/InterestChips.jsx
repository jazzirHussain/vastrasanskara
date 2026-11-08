import { Chip, Group, Text, TextInput } from '@mantine/core';

/** "Interested in": the house's garment types as chips (several may be picked), plus optional details. */
export function InterestChips({ garmentTypes, value, onChange, details, onDetails }) {
  return (
    <div role="group" aria-label="Interested in">
      <Text size="md" fw={500} mb={6}>
        Interested in
      </Text>
      <Chip.Group multiple value={value} onChange={onChange}>
        <Group gap="xs">
          {garmentTypes.slice(0, 20).map((t) => (
            <Chip key={t.key} value={t.key} size="md" variant="outline">
              {t.label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      <TextInput mt="xs" label="Details (optional)" size="md" maxLength={300} value={details} onChange={(e) => onDetails(e.currentTarget.value)} />
    </div>
  );
}
