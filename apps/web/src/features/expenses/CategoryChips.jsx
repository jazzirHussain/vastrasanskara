import { useState } from 'react';
import { Anchor, Button, Group, Text } from '@mantine/core';

const STORAGE_KEY = 'vs.expense.recentCategories';
const SHOWN = 6;

function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** Remembers the category as the most recently used on this phone. */
export function rememberCategory(key) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([key, ...readRecent().filter((k) => k !== key)].slice(0, 12)));
  } catch {
    // Private mode or blocked storage: the order simply stays as it was.
  }
}

/**
 * "What for?": the active categories as chips, the six used most recently first; "More" shows the rest.
 * `current` ({ key, label }) is the saved expense's own category, shown even if it is now hidden.
 */
export function CategoryChips({ categories, value, onChange, current = null, error }) {
  const [showAll, setShowAll] = useState(false);
  const active = categories.filter((c) => c.active);
  if (current && !active.some((c) => c.key === current.key)) active.push({ ...current, active: false });
  const recent = readRecent();
  const rank = (c) => {
    const i = recent.indexOf(c.key);
    return i === -1 ? recent.length : i;
  };
  const ordered = [...active].sort((a, b) => rank(a) - rank(b));
  const top = ordered.slice(0, SHOWN);
  // The chosen category stays visible even when it is one of the "More" ones.
  const chosen = ordered.find((c) => c.key === value);
  if (chosen && !top.includes(chosen)) top[SHOWN - 1] = chosen;
  const shown = showAll ? ordered : top;
  return (
    <div role="group" aria-label="What for?">
      <Text size="md" fw={500} mb={6}>
        What for?
      </Text>
      <Group gap="xs">
        {shown.map((c) => (
          <Button key={c.key} size="md" radius="xl" variant={value === c.key ? 'filled' : 'default'} aria-pressed={value === c.key} onClick={() => onChange(c.key)}>
            {c.label}
          </Button>
        ))}
      </Group>
      {ordered.length > SHOWN && (
        <Anchor component="button" type="button" size="md" mt="xs" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Fewer' : 'More'}
        </Anchor>
      )}
      {error && (
        <Text size="sm" c="red" mt={4}>
          {error}
        </Text>
      )}
    </div>
  );
}
