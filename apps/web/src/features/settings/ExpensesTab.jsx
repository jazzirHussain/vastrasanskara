import { useState } from 'react';
import { ActionIcon, Button, Group, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react';

/** 'Gift & decor' -> 'gift_decor' (lowercase, other characters become _, at most 40). */
export const toCategoryKey = (label) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/** A key not used yet: key, key_2, key_3 … (each kept within 40 characters). */
export function uniqueCategoryKey(label, taken) {
  const base = toCategoryKey(label) || 'category';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base.slice(0, 40 - String(n).length - 1)}_${n}`;
  return key;
}

/** The kinds of spending staff pick from: rename, show or hide, reorder, add. Nothing is deleted. */
export function ExpensesTab({ values, set, errors }) {
  const cats = values.expenseCategories;
  const [newLabel, setNewLabel] = useState('');
  const update = (index, changes) => set('expenseCategories', cats.map((c, i) => (i === index ? { ...c, ...changes } : c)));
  const move = (index, by) => {
    const next = [...cats];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    set('expenseCategories', next);
  };
  const label = newLabel.trim();
  const duplicate = cats.some((c) => c.label.trim().toLowerCase() === label.toLowerCase());

  function add() {
    if (!label || duplicate) return;
    set('expenseCategories', [...cats, { key: uniqueCategoryKey(label, new Set(cats.map((c) => c.key))), label, active: true }]);
    setNewLabel('');
  }

  return (
    <Stack>
      <div>
        <Title order={4}>Expense categories</Title>
        <Text size="sm" c="var(--vs-muted)">
          Hidden categories stay on old expenses but are not offered for new ones.
        </Text>
      </div>
      <div className="vs-stack">
        {cats.map((c, i) => (
          <div key={c.key} className="vs-stack-row" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
            <TextInput
              aria-label={`Category name ${i + 1}`}
              value={c.label}
              maxLength={40}
              onChange={(e) => update(i, { label: e.currentTarget.value })}
              error={errors[`expenseCategories.${i}.label`]}
              style={{ flex: '1 1 200px', minWidth: 0 }}
            />
            <Group gap={4} wrap="nowrap" align="center" style={{ minHeight: 36 }}>
              <Switch
                aria-label={`${c.label} shown`}
                label={c.active ? 'Shown' : 'Hidden'}
                checked={c.active}
                onChange={(e) => update(i, { active: e.currentTarget.checked })}
                style={{ minWidth: 92 }}
              />
              <ActionIcon variant="default" size={36} aria-label={`Move ${c.label} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <IconArrowUp size={18} />
              </ActionIcon>
              <ActionIcon variant="default" size={36} aria-label={`Move ${c.label} down`} disabled={i === cats.length - 1} onClick={() => move(i, 1)}>
                <IconArrowDown size={18} />
              </ActionIcon>
            </Group>
          </div>
        ))}
      </div>
      {errors.expenseCategories && <Text c="red" size="sm">{errors.expenseCategories}</Text>}
      <Group align="flex-end">
        <TextInput
          label="New category"
          placeholder="e.g. Gifts"
          maxLength={40}
          value={newLabel}
          onChange={(e) => setNewLabel(e.currentTarget.value)}
          error={duplicate ? 'This category already exists' : null}
        />
        <Button variant="light" onClick={add} disabled={!label || duplicate}>
          Add category
        </Button>
      </Group>
    </Stack>
  );
}
