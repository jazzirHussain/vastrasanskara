import { useState } from 'react';
import { Anchor, Chip, Group, Text, TextInput } from '@mantine/core';
import { shortDate } from '../../components/DateLabel.jsx';
import { followUpChoices } from './enquiryForm.js';

const NONE = 'none';

/**
 * "Call back on": Today / Tomorrow / In 3 days / Next week chips and "Pick a date". With
 * `allowNone`, "No more calls" sends null.
 */
export function FollowUpChips({ today, value, onChange, allowNone = false, label = 'Call back on' }) {
  const choices = followUpChoices(today);
  const [picking, setPicking] = useState(Boolean(value) && !choices.some((c) => c.date === value));
  const chip = value === null ? NONE : choices.find((c) => c.date === value)?.date ?? '';
  return (
    <div role="group" aria-label={label}>
      <Text size="md" fw={500} mb={6}>
        {label}
      </Text>
      <Chip.Group
        multiple={false}
        value={chip}
        onChange={(v) => {
          setPicking(false);
          onChange(v === NONE ? null : v);
        }}
      >
        <Group gap="xs">
          {choices.map((c) => (
            <Chip key={c.label} value={c.date} type="radio" size="md" variant="outline">
              {c.label}
            </Chip>
          ))}
          {allowNone && (
            <Chip value={NONE} type="radio" size="md" variant="outline">
              No more calls
            </Chip>
          )}
        </Group>
      </Chip.Group>
      {picking ? (
        <TextInput mt="xs" type="date" size="md" label="Call back date" min={today} value={value ?? ''} onChange={(e) => e.currentTarget.value && onChange(e.currentTarget.value)} />
      ) : (
        <Group gap="xs" mt="xs">
          {value && !chip && <Text size="sm">{shortDate(value)}</Text>}
          <Anchor component="button" type="button" size="sm" onClick={() => setPicking(true)}>
            Pick a date
          </Anchor>
        </Group>
      )}
    </div>
  );
}
