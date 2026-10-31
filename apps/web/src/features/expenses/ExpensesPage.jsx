import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ActionIcon, Alert, Button, Chip, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import { IconChevronLeft, IconChevronRight, IconLink, IconPhoto, IconReceipt, IconSearch, IconX } from '@tabler/icons-react';
import { useAuth } from '../../auth/AuthContext.js';
import { shortDate, todayYmd } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { Money } from '../../components/Money.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { monthLabel } from '../../lib/dates.js';
import { MODE_LABELS } from '../billing/billStatus.js';
import { useExpenses, useExpenseSummary } from './expensesApi.js';
import { MonthSummary } from './MonthSummary.jsx';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function shiftMonth(month, by) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function MonthSwitcher({ month, thisMonth, onChange }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <ActionIcon variant="default" size={44} aria-label="Previous month" onClick={() => onChange(shiftMonth(month, -1))}>
        <IconChevronLeft size={22} />
      </ActionIcon>
      <Text fw={600} size="lg" ta="center" style={{ minWidth: 150 }} aria-live="polite">
        {monthLabel(month)}
      </Text>
      <ActionIcon variant="default" size={44} aria-label="Next month" disabled={month >= thisMonth} onClick={() => onChange(shiftMonth(month, 1))}>
        <IconChevronRight size={22} />
      </ActionIcon>
    </Group>
  );
}

function ExpenseRow({ expense: e }) {
  const voided = e.status === 'voided';
  const struck = voided ? { textDecoration: 'line-through', color: 'var(--vs-muted)' } : undefined;
  return (
    <Link
      to={`/expenses/${e.id}`}
      className="vs-row"
      data-expense={e.id}
      style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 64, padding: '10px 12px', color: 'inherit', textDecoration: 'none', borderBottom: '1px solid var(--vs-rule)' }}
    >
      <div style={{ flex: 1, minWidth: 0 }} data-struck={voided ? '' : undefined}>
        <Text fw={600} style={struck}>
          {e.category.label}
        </Text>
        <Text size="sm" c="var(--vs-muted)" style={struck}>
          {e.payee.name}
        </Text>
        <Group gap={8} mt={2}>
          <Text size="xs" c="var(--vs-muted)">
            {MODE_LABELS[e.mode] ?? e.mode}
          </Text>
          {e.hasGst && <IconReceipt size={16} aria-label="GST bill" color="var(--vs-muted)" />}
          {e.photos > 0 && <IconPhoto size={16} aria-label="Has a photo" color="var(--vs-muted)" />}
          {e.linked && <IconLink size={16} aria-label="Linked to an order" color="var(--vs-muted)" />}
          {voided && <StatusBadge status="cancelled" label="Voided" />}
        </Group>
      </div>
      <Money paise={e.total} style={{ fontWeight: 600, ...struck }} />
    </Link>
  );
}

function Days({ rows }) {
  const days = [];
  for (const row of rows) {
    const last = days.at(-1);
    if (last?.date === row.date) last.rows.push(row);
    else days.push({ date: row.date, rows: [row] });
  }
  return days.map((day) => (
    <section key={day.date} aria-label={shortDate(day.date)} style={{ marginBottom: 16 }}>
      <Text size="sm" fw={600} c="var(--vs-muted)" mb={4}>
        {shortDate(day.date)}
      </Text>
      <div className="vs-panel" style={{ overflow: 'hidden' }}>
        {day.rows.map((e) => (
          <ExpenseRow key={e.id} expense={e} />
        ))}
      </div>
    </section>
  ));
}

/** Expenses of one month: the total and category split, then the list by day. Filters live in the address (`?month=&category=&noBill=&status=`). */
export function ExpensesPage() {
  const { can } = useAuth();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [params, setParams] = useSearchParams();
  const thisMonth = todayYmd().slice(0, 7);
  const asked = params.get('month');
  const month = MONTH.test(asked ?? '') && asked <= thisMonth ? asked : thisMonth;
  const category = params.get('category') ?? '';
  const noBill = params.get('noBill') === 'true';
  const voided = params.get('status') === 'voided';
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);

  const summary = useExpenseSummary(month);
  const list = useExpenses({
    month,
    ...(category && { category }),
    ...(noBill && { noBill: 'true' }),
    ...(voided && { status: 'voided' }),
    ...(q && { q }),
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const canWrite = can('expenses.write');

  // Changes some filters and keeps the others; a null value removes one.
  const setFilter = (patch) => {
    const next = { ...(month !== thisMonth && { month }), ...(category && { category }), ...(noBill && { noBill: 'true' }), ...(voided && { status: 'voided' }), ...patch };
    setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v)), { replace: true });
  };
  const chip = voided ? '__voided' : category || 'all';
  const onChip = (value) => setFilter(value === '__voided' ? { status: 'voided', category: null } : value === 'all' ? { category: null, status: null } : { category: value, status: null });
  const categories = summary.data?.byCategory.map((r) => r.category) ?? [];
  if (category && !categories.some((c) => c.key === category)) categories.push({ key: category, label: category });
  const filtered = Boolean(category || noBill || voided || q);
  const addButton = (
    <Button component={Link} to="/expenses/new" size={phone ? 'lg' : 'md'} fullWidth={phone}>
      Add expense
    </Button>
  );

  return (
    <>
      <PageHeader title="Expenses" action={canWrite && !phone ? addButton : null} />
      <Stack gap="md" style={{ paddingBottom: phone && canWrite ? 168 : 0 }}>
        <MonthSwitcher month={month} thisMonth={thisMonth} onChange={(m) => setParams(m === thisMonth ? {} : { month: m }, { replace: true })} />
        {(summary.isPending || summary.isPlaceholderData) && <Loader />}
        {summary.error && <Alert color="red">{summary.error.message}</Alert>}
        {summary.data && !summary.isPlaceholderData && (
          <MonthSummary
            summary={summary.data}
            category={category}
            onCategory={(key) => setFilter({ category: key === category ? null : key, status: null })}
            onNoBill={() => setFilter({ noBill: 'true' })}
          />
        )}
        <TextInput
          aria-label="Search expenses"
          placeholder="Number or paid to"
          leftSection={<IconSearch size={16} aria-hidden="true" />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          maxLength={30}
          maw={420}
        />
        <Chip.Group multiple={false} value={chip} onChange={onChip}>
          <Group gap="xs">
            <Chip value="all" type="radio" variant="outline" size="md">
              All
            </Chip>
            {categories.map((c) => (
              <Chip key={c.key} value={c.key} type="radio" variant="outline" size="md">
                {c.label}
              </Chip>
            ))}
            <Chip value="__voided" type="radio" variant="outline" size="md">
              Voided
            </Chip>
          </Group>
        </Chip.Group>
        {noBill && (
          <Group gap="xs">
            <Text size="sm">Showing GST bills without a photo</Text>
            <Button variant="subtle" size="compact-md" leftSection={<IconX size={14} />} onClick={() => setFilter({ noBill: null })}>
              Show all
            </Button>
          </Group>
        )}
        {list.isPending && <Loader />}
        {list.error && <Alert color="red">{list.error.message}</Alert>}
        {list.data && rows.length === 0 && (
          <EmptyState
            title={filtered ? 'No expenses match' : `No expenses in ${monthLabel(month).split(' ')[0]} yet.`}
            body={filtered ? 'Try another category or search.' : undefined}
            action={
              canWrite &&
              !filtered && (
                <Button component={Link} to="/expenses/new">
                  Add expense
                </Button>
              )
            }
          />
        )}
        {rows.length > 0 && <Days rows={rows} />}
        <LoadMore query={list} />
      </Stack>
      {phone && canWrite && (
        <div style={{ position: 'fixed', left: 16, right: 16, bottom: 'calc(72px + env(safe-area-inset-bottom))', zIndex: 20 }}>{addButton}</div>
      )}
    </>
  );
}
