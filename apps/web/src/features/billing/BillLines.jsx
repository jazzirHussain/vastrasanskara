import { useState } from 'react';
import { Button, Group, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { formatINR } from '@vs/shared/money.js';
import { lineForItem, switchDiscountMode } from './draftForm.js';

const HALDI_TEXT = 'var(--mantine-color-haldi-8)';
const money = { thousandSeparator: ',', thousandsGroupStyle: 'lakh', decimalScale: 2, allowNegative: false, hideControls: true };

/** A yellow note under a field: something to do before issuing, not an error. */
function Todo({ children }) {
  return (
    <Text size="sm" fw={600} c={HALDI_TEXT} mt={4}>
      {children}
    </Text>
  );
}

/** A discount in ₹ or %, with "Why?" once there is one. `base` is what a percentage is taken of. */
export function DiscountField({ label, discount, base, errors, onChange, idPrefix }) {
  const shown = discount.value !== '' || discount.reason !== '';
  return (
    <>
      <div>
        <Group gap={6} align="flex-end" wrap="nowrap">
          <NumberInput
            id={`${idPrefix}-discount`}
            label={label}
            size="md"
            style={{ flex: 1, minWidth: 0 }}
            {...money}
            thousandSeparator={discount.mode === 'amount' ? ',' : undefined}
            value={discount.value}
            onChange={(value) => onChange({ ...discount, value })}
            error={errors.discount}
          />
          <SegmentedControl
            aria-label={`${label} in`}
            size="md"
            data={[
              { value: 'amount', label: '₹' },
              { value: 'percent', label: '%' },
            ]}
            value={discount.mode}
            onChange={(mode) => mode !== discount.mode && onChange(switchDiscountMode(discount, base))}
            style={{ marginBottom: errors.discount ? 24 : 0 }}
          />
        </Group>
      </div>
      {shown && (
        <TextInput
          label="Why?"
          size="md"
          placeholder="For example: regular customer"
          value={discount.reason}
          onChange={(e) => onChange({ ...discount, reason: e.currentTarget.value })}
          error={errors.reason}
        />
      )}
    </>
  );
}

function itemOptions(items, currentId, itemsById) {
  const options = items.map((i) => ({ value: i.id, label: i.name }));
  const current = itemsById.get(currentId);
  if (current && !current.active) options.push({ value: current.id, label: `${current.name} (no longer on the price list)` });
  return options;
}

function LineCard({ n, line, check, items, itemsById, canDiscount, onChange, onRemove, onCommit }) {
  const set = (fields, commit = false) => onChange({ ...line, ...fields }, commit);
  const id = `line-${line.key}`;
  return (
    <div role="group" aria-label={`Line ${n}`} className="vs-panel" style={{ padding: 16 }} onBlur={onCommit}>
      <Stack gap="sm">
        <TextInput
          id={`${id}-description`}
          label="Description"
          size="md"
          value={line.description}
          onChange={(e) => set({ description: e.currentTarget.value })}
          error={check.errors.description}
        />
        <div>
          <Select
            id={`${id}-item`}
            label="Billed as"
            size="md"
            placeholder="Choose from the price list"
            searchable
            allowDeselect={false}
            nothingFoundMessage="Nothing on the price list matches"
            data={itemOptions(items, line.itemId, itemsById)}
            value={line.itemId}
            onChange={(itemId) => set({ itemId }, true)}
            styles={check.warnings.item ? { input: { borderColor: 'var(--mantine-color-haldi-6)', borderWidth: 2 } } : undefined}
          />
          {check.warnings.item && <Todo>{check.warnings.item}</Todo>}
        </div>
        <SimpleGrid cols={{ base: 2, sm: canDiscount ? 4 : 2 }} spacing="sm">
          <NumberInput
            id={`${id}-quantity`}
            label="Quantity"
            size="md"
            min={0}
            decimalScale={3}
            allowNegative={false}
            hideControls
            value={line.quantity}
            onChange={(quantity) => set({ quantity })}
            error={check.errors.quantity}
          />
          <div>
            <NumberInput
              id={`${id}-price`}
              label="Price (₹)"
              size="md"
              {...money}
              value={line.price}
              onChange={(price) => set({ price })}
              error={check.errors.price}
            />
            {!check.errors.price && check.warnings.price && <Todo>{check.warnings.price}</Todo>}
          </div>
          {canDiscount && (
            <DiscountField
              idPrefix={id}
              label="Discount"
              discount={line.discount}
              base={check.gross ?? 0}
              errors={check.errors}
              onChange={(discount) => set({ discount })}
            />
          )}
        </SimpleGrid>
        {!canDiscount && check.discount > 0 && (
          <Text size="sm" c="var(--vs-muted)">
            Discount {formatINR(check.discount)}: {line.discount.reason}
          </Text>
        )}
        <Group justify="space-between" align="center">
          <Text size="sm">
            Amount{' '}
            <span className="vs-figures" style={{ fontWeight: 700 }}>
              {check.amount === null ? '—' : formatINR(check.amount)}
            </span>
          </Text>
          <Button variant="subtle" color="kumkum" onClick={onRemove}>
            Remove
          </Button>
        </Group>
      </Stack>
    </div>
  );
}

/** Picks a price-list item for a new line. */
function AddItem({ items, onAdd }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="default" size="md" onClick={() => setOpen(true)} disabled={!items.length} style={{ alignSelf: 'flex-start' }}>
        Add item
      </Button>
    );
  }
  return (
    <Group align="flex-end" gap="xs">
      <Select
        label="Add from the price list"
        size="md"
        searchable
        dropdownOpened
        placeholder="Type to search"
        nothingFoundMessage="Nothing on the price list matches"
        data={items.map((i) => ({ value: i.id, label: i.name }))}
        value={null}
        onChange={(id) => {
          setOpen(false);
          if (id) onAdd(items.find((i) => i.id === id));
        }}
        style={{ flex: 1, minWidth: 220 }}
        data-autofocus
      />
      <Button variant="subtle" color="gray" size="md" onClick={() => setOpen(false)}>
        Close
      </Button>
    </Group>
  );
}

/**
 * The draft's lines, one card each: description, what it is billed as, quantity, price and
 * discount, the line's amount and Remove; then "Add item". `onChange(lines, commit)` — commit
 * saves straight away (choices, adding, removing); typed fields save when the card loses focus.
 */
export function BillLines({ lines, checks, items, itemsById, canDiscount, onChange, onCommit }) {
  const replace = (i, line, commit) => onChange(lines.map((l, j) => (j === i ? line : l)), commit);
  return (
    <Stack gap="sm">
      {lines.length === 0 && (
        <Text c="var(--vs-muted)" size="sm">
          Nothing on this bill yet. Add an item from the price list.
        </Text>
      )}
      {lines.map((line, i) => (
        <LineCard
          key={line.key}
          n={i + 1}
          line={line}
          check={checks[i]}
          items={items}
          itemsById={itemsById}
          canDiscount={canDiscount}
          onChange={(next, commit) => replace(i, next, commit)}
          onRemove={() => onChange(lines.filter((_, j) => j !== i), true)}
          onCommit={onCommit}
        />
      ))}
      <AddItem items={items} onAdd={(item) => onChange([...lines, lineForItem(item)], true)} />
    </Stack>
  );
}
