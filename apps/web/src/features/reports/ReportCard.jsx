import { useState } from 'react';
import { Alert, Button, Group, Paper, Radio, Select, Stack, Text, TextInput } from '@mantine/core';
import { useCustomers } from '../customers/customersApi.js';
import { reportErrorText, useRequestReport, withKey } from './reportsApi.js';

export const FORMAT_LABELS = { xlsx: 'Excel', csv: 'CSV', pdf: 'PDF' };
// Excel first (the default), then CSV, then PDF.
const FORMAT_ORDER = ['xlsx', 'csv', 'pdf'];

export const DESCRIPTIONS = {
  gstr1: 'Your sales for the month, in the layout the GST offline tool takes.',
  gstr3b: 'Tax on sales, tax you can claim back, and what is left to pay.',
  gst_pack: 'GSTR-1 and the GST summary with registers, together.',
  sales_register: 'Every bill in the period, with GST.',
  credit_note_register: 'Every credit note in the period.',
  receipt_voucher_register: 'Advances taken, with the GST on them.',
  refund_register: 'Money paid back to customers.',
  collections_by_mode: 'Money in and out each day, by cash, UPI, card or bank.',
  advances_held: 'Money customers have paid that is not yet used on a bill.',
  expense_register: 'Every expense with its GST, and totals by category.',
  stock_movements: 'Everything that came in or went out of stock.',
  stock_valuation: 'What your stock is worth today.',
  customer_statement: 'One customer’s bills and payments, with balances.',
  receivables_ageing: 'Who owes you, and how late.',
  day_book: 'Every bill, payment, refund and expense by date.',
  order_profitability: 'What each billed order made after costs.',
  on_time: 'How often garments were ready on time, by designer and vendor.',
  enquiry_conversion: 'Enquiries by how people heard of you, and how many became orders.',
  stock_item_profit: 'What each stock item earned when used or sold.',
};

const pad = (n) => String(n).padStart(2, '0');
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** 'YYYY-MM' of last month (IST). */
export function lastMonthYm(today = istToday()) {
  const [y, m] = today.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** The dates of a period choice. */
export function periodRange(period, today = istToday()) {
  const month = today.slice(0, 7);
  if (period === 'last_month') {
    const lm = lastMonthYm(today);
    return { from: `${lm}-01`, to: addDays(`${month}-01`, -1) };
  }
  if (period === 'fy') {
    const y = Number(today.slice(0, 4));
    return { from: `${Number(today.slice(5, 7)) >= 4 ? y : y - 1}-04-01`, to: today };
  }
  return { from: `${month}-01`, to: today };
}

const PERIODS = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'fy', label: 'This financial year' },
];

function CustomerPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const customers = useCustomers(q);
  const data = (customers.data?.pages.flatMap((p) => p.items) ?? []).map((c) => ({ value: c.id, label: c.name }));
  return (
    <Select label="Customer" placeholder="Search by name or phone" searchable searchValue={q} onSearchChange={setQ} data={data} value={value} onChange={onChange} nothingFoundMessage="No customer found" />
  );
}

/** One report: what it is, its period, its format and "Get file". */
export function ReportCard({ report }) {
  const request = useRequestReport();
  const [month, setMonth] = useState(lastMonthYm());
  const [period, setPeriod] = useState('this_month');
  const [customerId, setCustomerId] = useState(null);
  const [format, setFormat] = useState(report.formats.includes('xlsx') ? 'xlsx' : report.formats[0]);

  const params = () => {
    if (report.params === 'month') return { month };
    if (report.params === 'range') return periodRange(period);
    if (report.params === 'customer') return { customerId, ...periodRange(period) };
    return {};
  };
  const ready = report.params !== 'customer' || Boolean(customerId);

  return (
    <Paper component="section" aria-label={report.label} withBorder radius="md" p="md">
      <Stack gap="xs">
        <Text fw={600}>{report.label}</Text>
        <Text size="sm" c="var(--vs-muted)">
          {DESCRIPTIONS[report.kind]}
        </Text>
        {report.params === 'month' && <TextInput label="Month" placeholder="YYYY-MM" value={month} onChange={(e) => setMonth(e.currentTarget.value)} />}
        {report.params === 'customer' && <CustomerPicker value={customerId} onChange={setCustomerId} />}
        {(report.params === 'range' || report.params === 'customer') && (
          <Select label="Period" data={PERIODS} value={period} onChange={(v) => setPeriod(v ?? 'this_month')} allowDeselect={false} />
        )}
        {report.formats.length > 1 && (
          <Radio.Group label="Format" value={format} onChange={setFormat}>
            <Group gap="md" mt={4}>
              {FORMAT_ORDER.filter((f) => report.formats.includes(f)).map((f) => (
                <Radio key={f} value={f} label={FORMAT_LABELS[f]} />
              ))}
            </Group>
          </Radio.Group>
        )}
        {request.error && (
          <Alert color="kumkum" variant="light" role="alert">
            {reportErrorText(request.error)}
          </Alert>
        )}
        <Group>
          <Button size="md" disabled={!ready} loading={request.isPending} onClick={() => request.mutate(withKey({ kind: report.kind, format, params: params() }))}>
            Get file
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
