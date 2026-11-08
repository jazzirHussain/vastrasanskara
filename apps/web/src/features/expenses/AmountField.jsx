import { TextInput } from '@mantine/core';

/** "How much?": the total paid, in rupees. Big, numeric keypad, focused on a new expense. */
export function AmountField({ value, onChange, autoFocus = false, error, label = 'How much?' }) {
  return (
    <TextInput
      label={label}
      size="xl"
      inputMode="decimal"
      autoComplete="off"
      autoFocus={autoFocus}
      leftSection="₹"
      placeholder="0"
      error={error}
      value={value}
      onChange={(e) => {
        const text = e.currentTarget.value.replace(/[^0-9.]/g, '');
        if ((text.match(/\./g) ?? []).length <= 1) onChange(text);
      }}
      styles={{ input: { fontSize: 28, fontWeight: 700 }, label: { fontSize: 16 } }}
    />
  );
}
