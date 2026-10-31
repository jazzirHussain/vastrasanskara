import { Button, SimpleGrid, Text, TextInput } from '@mantine/core';
import { MODES } from '../billing/billStatus.js';

const REFERENCE_LABEL = { bank_transfer: 'Bank reference (optional)' };

/** "How did you pay?": four big buttons, and a reference box for anything but cash. */
export function ModeButtons({ mode, reference, onMode, onReference }) {
  return (
    <div>
      <div role="group" aria-label="How did you pay?">
        <Text size="md" fw={500} mb={6}>
          How did you pay?
        </Text>
        <SimpleGrid cols={2} spacing="sm">
          {MODES.map((m) => (
            <Button key={m.value} size="lg" variant={mode === m.value ? 'filled' : 'default'} aria-pressed={mode === m.value} onClick={() => onMode(m.value)}>
              {m.label}
            </Button>
          ))}
        </SimpleGrid>
      </div>
      {mode !== 'cash' && (
        <TextInput mt="sm" size="md" label={REFERENCE_LABEL[mode] ?? 'UPI or card reference (optional)'} maxLength={100} value={reference} onChange={(e) => onReference(e.currentTarget.value)} />
      )}
    </div>
  );
}
