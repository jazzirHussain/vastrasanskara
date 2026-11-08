import { useState } from 'react';
import { ActionIcon, Group, TextInput, UnstyledButton } from '@mantine/core';
import { IconMinus, IconPlus } from '@tabler/icons-react';
import { qtyInput, qtyText, showQty } from './qty.js';

/**
 * − / quantity / + for milli-unit quantities: each button moves by `step`; tapping the quantity
 * lets it be typed. Never goes below `min`.
 */
export function QtyStepper({ value, onChange, step = 1000, unit, min = 0, label = 'Quantity' }) {
  const [typing, setTyping] = useState(null);
  const commit = () => {
    const typed = qtyInput(typing);
    if (typed !== null) onChange(Math.max(min, typed));
    setTyping(null);
  };
  return (
    <Group gap="xs" wrap="nowrap">
      <ActionIcon variant="default" size={44} aria-label="Less" disabled={value - step < min} onClick={() => onChange(Math.max(min, value - step))}>
        <IconMinus size={20} />
      </ActionIcon>
      {typing === null ? (
        <UnstyledButton
          aria-label={`${label}: ${showQty(value, unit)}. Tap to type`}
          onClick={() => setTyping(qtyText(value))}
          style={{ minWidth: 96, minHeight: 44, textAlign: 'center', fontWeight: 600, fontSize: 18 }}
          className="vs-figures"
        >
          {showQty(value, unit)}
        </UnstyledButton>
      ) : (
        <TextInput
          aria-label={label}
          value={typing}
          onChange={(e) => setTyping(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          rightSection={<span style={{ fontSize: 12 }}>{unit}</span>}
          inputMode="decimal"
          autoFocus
          w={120}
          size="md"
        />
      )}
      <ActionIcon variant="default" size={44} aria-label="More" onClick={() => onChange(value + step)}>
        <IconPlus size={20} />
      </ActionIcon>
    </Group>
  );
}
