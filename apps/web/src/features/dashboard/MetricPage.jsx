import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Anchor, Badge, CloseButton, Group, Loader, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { METRICS } from '@vs/shared/dashboard.js';
import { formatINR } from '@vs/shared/money.js';
import { DateLabel } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { Money } from '../../components/Money.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { clean, useMetricRows } from './dashboardApi.js';

const PRESET_LABELS = { today: 'Today', week: 'This week', month: 'This month', fy: 'This year', custom: 'Custom dates' };
const CHIP_LABELS = {
  priority: { rush: 'Rush orders', normal: 'Normal orders' },
  customerType: { individual: 'Individual customers', business: 'Business customers', film_production: 'Film customers' },
};

function NotAvailable() {
  return (
    <EmptyState
      title="This list is not available."
      action={
        <Anchor component={Link} to="/">
          Back to Home
        </Anchor>
      }
    />
  );
}

/** The records behind one Home number, with the same filters; filter chips can be removed. */
export function MetricPage() {
  const { metric } = useParams();
  const [params, setParams] = useSearchParams();
  const known = Object.hasOwn(METRICS, metric);
  const filters = clean({
    preset: params.get('preset') ?? 'month',
    from: params.get('from'),
    to: params.get('to'),
    designerId: params.get('designerId'),
    priority: params.get('priority'),
    customerType: params.get('customerType'),
  });
  const key = params.get('key') ?? undefined;
  const rows = useMetricRows(metric, filters, key, { enabled: known });
  if (!known || rows.error?.status === 404) return <NotAvailable />;

  const first = rows.data?.pages[0];
  const items = rows.data?.pages.flatMap((p) => p.items) ?? [];
  const remove = (name) => {
    const next = new URLSearchParams(params);
    next.delete(name);
    setParams(next, { replace: true });
  };
  const chips = [
    ...['priority', 'customerType'].filter((k) => filters[k]).map((k) => ({ name: k, label: CHIP_LABELS[k][filters[k]] ?? filters[k] })),
    ...(filters.designerId ? [{ name: 'designerId', label: 'One designer' }] : []),
    ...(key ? [{ name: 'key', label: `Only: ${key}` }] : []),
  ];

  return (
    <Stack gap="md">
      <PageHeader title={first?.metric.label ?? METRICS[metric].label}>
        {first && (
          <Group gap="sm" mt={4}>
            <Text fz={22} fw={600} className="vs-figures">
              {first.metric.amount !== undefined ? formatINR(first.metric.amount) : (first.metric.count ?? '')}
            </Text>
            {first.metric.count !== undefined && first.metric.amount !== undefined && (
              <Text c="var(--vs-muted)">{first.metric.count === 1 ? '1 record' : `${first.metric.count} records`}</Text>
            )}
          </Group>
        )}
      </PageHeader>
      <Group gap="xs">
        <Badge variant="outline" size="lg" style={{ textTransform: 'none' }}>
          {PRESET_LABELS[filters.preset] ?? filters.preset}
        </Badge>
        {chips.map((c) => (
          <Badge
            key={c.name}
            variant="light"
            size="lg"
            style={{ textTransform: 'none' }}
            rightSection={<CloseButton size="sm" aria-label={`Remove ${c.label}`} onClick={() => remove(c.name)} />}
          >
            {c.label}
          </Badge>
        ))}
      </Group>
      {rows.isPending && <Loader size="sm" />}
      {first && items.length === 0 && <Text c="var(--vs-muted)">Nothing here for this period.</Text>}
      {items.length > 0 && (
        <Paper withBorder radius="md" component="ul" aria-label="Records" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((r, i) => (
            <li key={`${r.id}-${i}`} style={{ borderTop: i ? '1px solid var(--vs-rule)' : 0 }}>
              <UnstyledButton component={Link} to={r.link} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 12px', minHeight: 56 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <Text fw={600} size="sm">
                    {r.title}
                  </Text>
                  <Text size="xs" c="var(--vs-muted)">
                    {r.subtitle}
                  </Text>
                </span>
                <span style={{ textAlign: 'right' }}>
                  {r.amount !== undefined && <Money paise={r.amount} style={{ display: 'block', fontWeight: 600 }} />}
                  {r.date && (
                    <Text size="xs">
                      <DateLabel ymd={r.date} relative={false} />
                    </Text>
                  )}
                  {r.badge && (
                    <Badge size="sm" variant="light" style={{ textTransform: 'none' }}>
                      {r.badge}
                    </Badge>
                  )}
                </span>
              </UnstyledButton>
            </li>
          ))}
        </Paper>
      )}
      <LoadMore query={rows} />
    </Stack>
  );
}
