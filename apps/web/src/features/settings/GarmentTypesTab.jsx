import { useState } from 'react';
import { Button, Group, Stack, TagsInput, Text, TextInput, Title } from '@mantine/core';

export const toTypeKey = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** The garments the house makes and the measurements taken for each. */
export function GarmentTypesTab({ values, set, errors }) {
  const types = values.garmentTypes;
  const [newLabel, setNewLabel] = useState('');
  const update = (index, changes) => set('garmentTypes', types.map((t, i) => (i === index ? { ...t, ...changes } : t)));
  const newKey = toTypeKey(newLabel);
  const duplicate = types.some((t) => t.key === newKey);

  function add() {
    if (!newKey || duplicate) return;
    set('garmentTypes', [...types, { key: newKey, label: newLabel.trim(), measurementFields: [] }]);
    setNewLabel('');
  }

  return (
    <Stack>
      <div>
        <Title order={4}>Garment types</Title>
        <Text size="sm" c="var(--vs-muted)">
          Measurement forms and orders offer these. Press Enter after each measurement name.
        </Text>
      </div>
      {types.map((t, i) => (
        <div key={t.key} className="vs-panel" style={{ padding: 16 }}>
          <Group align="flex-start" grow preventGrowOverflow={false} wrap="wrap">
            <TextInput
              label="Name"
              aria-label={`${t.label} name`}
              value={t.label}
              onChange={(e) => update(i, { label: e.currentTarget.value })}
              error={errors[`garmentTypes.${i}.label`]}
              maw={240}
            />
            <TagsInput
              label="Measurements"
              aria-label={`${t.label} measurements`}
              placeholder="Add a measurement"
              value={t.measurementFields}
              onChange={(fields) => update(i, { measurementFields: fields })}
              error={errors[`garmentTypes.${i}.measurementFields`]}
              style={{ flex: 3, minWidth: 260 }}
            />
          </Group>
        </div>
      ))}
      {errors.garmentTypes && <Text c="red" size="sm">{errors.garmentTypes}</Text>}
      <Group align="flex-end">
        <TextInput
          label="New garment type"
          placeholder="e.g. Saree blouse"
          value={newLabel}
          onChange={(e) => setNewLabel(e.currentTarget.value)}
          error={duplicate ? 'This garment type already exists' : null}
        />
        <Button variant="light" onClick={add} disabled={!newKey || duplicate}>
          Add garment type
        </Button>
      </Group>
    </Stack>
  );
}
