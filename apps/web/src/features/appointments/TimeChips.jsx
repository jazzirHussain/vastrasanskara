import { useState } from 'react';
import { Anchor, Chip, Group, Text, TextInput } from '@mantine/core';
import { time12 } from './bookingForm.js';

/**
 * "Time": the designer's free quarter hours as chips; "Another time" reveals a time box for any
 * quarter hour (the server still refuses a clash).
 */
export function TimeChips({ choices, value, onChange, label = 'Time', loading = false }) {
  const [other, setOther] = useState(Boolean(value) && !choices.includes(value));
  const showOther = other || (Boolean(value) && !loading && !choices.includes(value));
  return (
    <div role="group" aria-label={label}>
      <Text size="md" fw={500} mb={6}>
        {label}
      </Text>
      {!loading && choices.length === 0 && (
        <Text size="sm" c="var(--vs-muted)" mb={6}>
          No free time left this day.
        </Text>
      )}
      <Chip.Group multiple={false} value={choices.includes(value) ? value : ''} onChange={(v) => { setOther(false); onChange(v); }}>
        <Group gap="xs">
          {choices.map((t) => (
            <Chip key={t} value={t} type="radio" size="md" variant="outline">
              {time12(t)}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      {showOther ? (
        <TextInput
          mt="xs"
          type="time"
          step={900}
          size="md"
          label="Another time"
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          description="On the quarter hour (:00, :15, :30, :45)."
        />
      ) : (
        <Anchor component="button" type="button" size="sm" mt="xs" onClick={() => setOther(true)}>
          Another time
        </Anchor>
      )}
    </div>
  );
}
