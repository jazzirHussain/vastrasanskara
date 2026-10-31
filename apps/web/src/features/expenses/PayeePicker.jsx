import { useState } from 'react';
import { Anchor, Button, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconCheck } from '@tabler/icons-react';
import { usePayees } from './expensesApi.js';

const FREE_TEXT = { vendorId: null, gstin: null, stateCode: null };

function Suggestion({ children, onPick, hint }) {
  return (
    <Button variant="default" size="md" fullWidth justify="space-between" onClick={onPick} styles={{ label: { whiteSpace: 'normal', textAlign: 'left' } }}>
      <span>{children}</span>
      {hint}
    </Button>
  );
}

/**
 * "Paid to": one box. Typing a name uses it as written; a vendor or a recent name from the
 * suggestions fills in what is known about it (GSTIN, state). `onChange(payee)` gets
 * { vendorId, name, gstin, stateCode }.
 */
export function PayeePicker({ payee, onChange, error }) {
  const [open, setOpen] = useState(false);
  const [debounced] = useDebouncedValue(payee.name.trim(), 250);
  const { data } = usePayees(open ? debounced : '');

  if (payee.vendorId) {
    return (
      <div>
        <Text size="md" fw={500} mb={6}>
          Paid to
        </Text>
        <Paper withBorder p="sm" radius="md">
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text fw={600}>{payee.name}</Text>
              {payee.gstin && (
                <Text size="sm" c="dimmed">
                  <IconCheck size={14} aria-hidden style={{ verticalAlign: -2 }} /> GSTIN on file
                </Text>
              )}
            </Stack>
            <Button variant="subtle" size="md" onClick={() => onChange({ ...FREE_TEXT, name: '' })}>
              Change
            </Button>
          </Group>
        </Paper>
      </div>
    );
  }

  const name = payee.name.trim();
  const vendors = data?.vendors ?? [];
  const recent = data?.recent ?? [];
  const exact = [...vendors, ...recent].some((p) => p.name.toLowerCase() === name.toLowerCase());
  const pick = (next) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div onBlur={() => setOpen(false)}>
      <TextInput
        label="Paid to"
        size="md"
        autoComplete="off"
        maxLength={100}
        placeholder="Shop or person"
        error={error}
        value={payee.name}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setOpen(true);
          onChange({ ...FREE_TEXT, name: e.currentTarget.value });
        }}
        styles={{ label: { fontSize: 16 } }}
      />
      {open && (
        <Stack gap="xs" mt="xs" onMouseDown={(e) => e.preventDefault()}>
          {name && !exact && (
            <Suggestion onPick={() => pick({ ...FREE_TEXT, name })}>{`Use "${name}"`}</Suggestion>
          )}
          {vendors.length > 0 && (
            <Text size="sm" c="dimmed" fw={600}>
              Vendors
            </Text>
          )}
          {vendors.map((v) => (
            <Suggestion
              key={v.id}
              onPick={() => pick({ vendorId: v.id, name: v.name, gstin: v.gstin, stateCode: v.stateCode })}
              hint={v.gstin ? <IconCheck size={16} aria-label="Has GSTIN" /> : null}
            >
              {v.name}
            </Suggestion>
          ))}
          {recent.length > 0 && (
            <Text size="sm" c="dimmed" fw={600}>
              Recent
            </Text>
          )}
          {recent.map((r) => (
            <Suggestion key={r.name} onPick={() => pick({ vendorId: null, name: r.name, gstin: r.gstin, stateCode: r.stateCode })}>
              {r.name}
            </Suggestion>
          ))}
          {name && (
            <Anchor component="button" type="button" size="sm" onClick={() => setOpen(false)} style={{ alignSelf: 'flex-start' }}>
              Done
            </Anchor>
          )}
        </Stack>
      )}
    </div>
  );
}
