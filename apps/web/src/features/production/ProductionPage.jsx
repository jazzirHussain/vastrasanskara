import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Anchor, Checkbox, Chip, Group, Loader, Stack, Text, UnstyledButton } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { DateLabel } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { stageName } from '../orders/stageSteps.js';
import { BulkBar } from './BulkBar.jsx';
import { useProductionBoard, useProductionGarments } from './productionApi.js';

const FILTERS = [
  { value: 'all', label: 'All', query: {} },
  { value: 'late', label: 'Late', query: { late: true } },
  { value: 'vendor', label: 'With vendor', query: { withVendor: true } },
];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One stage of the board: how many garments wait there, how many are out or late. */
function StageTile({ count, pressed, onClick }) {
  const total = count.inHouse + count.withVendor;
  const label = `${stageName(count.stage)}: ${plural(total, 'garment')}${count.late ? `, ${count.late} late` : ''}`;
  return (
    <UnstyledButton
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="vs-panel"
      style={{
        minWidth: 128,
        padding: '10px 12px',
        borderColor: pressed ? 'var(--vs-indigo)' : undefined,
        background: pressed ? '#EEEFF7' : undefined,
        opacity: total === 0 && !pressed ? 0.6 : 1,
      }}
    >
      <Text size="xs" c="var(--vs-muted)">
        {stageName(count.stage)}
      </Text>
      <Text fw={600} size="xl" className="vs-figures">
        {total}
      </Text>
      <Group gap={8}>
        {count.withVendor > 0 && (
          <Text size="xs" c="#875C0C">
            {count.withVendor} with vendor
          </Text>
        )}
        {count.late > 0 && (
          <Text size="xs" c="var(--vs-kumkum)">
            {count.late} late
          </Text>
        )}
      </Group>
    </UnstyledButton>
  );
}

function columns({ selectable, selectedIds, toggle }) {
  return [
    ...(selectable
      ? [
          {
            key: 'select',
            header: '',
            render: (r) => (
              <Checkbox
                aria-label={`Select ${r.garment.garmentNo}`}
                checked={selectedIds.includes(r.garment.id)}
                onChange={() => toggle(r.garment.id)}
              />
            ),
          },
        ]
      : []),
    {
      key: 'garment',
      header: 'Garment',
      primary: true,
      render: (r) => (
        <div>
          <Anchor component={Link} to={`/orders/${r.order.id}`} fw={600} className="vs-figures" style={{ whiteSpace: 'nowrap' }}>
            {r.garment.garmentNo}
          </Anchor>
          <Text size="sm" c="var(--vs-muted)">
            {r.garment.description}
          </Text>
        </div>
      ),
    },
    { key: 'customer', header: 'Customer', render: (r) => r.customer.name },
    { key: 'designer', header: 'Designer', hideOnPhone: true, render: (r) => r.designer.name },
    { key: 'stage', header: 'Stage', render: (r) => stageName(r.workingStage) },
    { key: 'due', header: 'Due', render: (r) => <DateLabel ymd={r.garment.dueDate ?? r.order.pickupDate} /> },
    {
      key: 'flags',
      header: '',
      render: (r) => (
        <Group gap={6} wrap="wrap">
          {r.order.priority === 'rush' && <StatusBadge status="rush" />}
          {r.late && <StatusBadge status="late" />}
          {r.garment.tightSchedule && <StatusBadge status="tight" />}
          {r.vendor && <StatusBadge status="with_vendor" label={`With ${r.vendor.name}`} />}
        </Group>
      ),
    },
  ];
}

/** Every open garment by stage, for designers to move along (alone or together). */
export function ProductionPage() {
  const { can } = useAuth();
  const selectable = can('production.update');
  const [stage, setStage] = useState(null);
  const [filter, setFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState([]);
  const board = useProductionBoard();
  const query = { ...(stage && { stage }), ...FILTERS.find((f) => f.value === filter).query };
  const garments = useProductionGarments(query);
  const rows = garments.data?.items ?? [];
  const selected = rows.filter((r) => selectedIds.includes(r.garment.id));
  const toggle = (id) => setSelectedIds((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]));
  const filtered = Boolean(stage) || filter !== 'all';

  return (
    <Stack gap={0}>
      <PageHeader title="Production" />
      {board.error && <Alert color="red">{board.error.message}</Alert>}
      {board.data && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 12 }}>
          {board.data.stages.map((count) => (
            <StageTile
              key={count.stage}
              count={count}
              pressed={stage === count.stage}
              onClick={() => setStage((s) => (s === count.stage ? null : count.stage))}
            />
          ))}
        </div>
      )}
      <Chip.Group multiple={false} value={filter} onChange={setFilter}>
        <Group gap="xs" mb="md">
          {FILTERS.map((f) => (
            <Chip key={f.value} value={f.value} type="radio" variant="outline" size="sm">
              {f.label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      {garments.isPending && <Loader />}
      {garments.error && <Alert color="red">{garments.error.message}</Alert>}
      {garments.data?.truncated && (
        <Alert color="yellow" mb="sm">
          Only the first 1000 garments are shown. Choose a stage to narrow the list.
        </Alert>
      )}
      {garments.data && rows.length === 0 && (
        <EmptyState
          title={filtered ? 'No garments match' : 'Nothing in production'}
          body={filtered ? 'Try another stage or filter.' : 'Garments appear here once an order is taken.'}
        />
      )}
      {rows.length > 0 && (
        <ResponsiveTable label="Garments in production" rows={rows} rowKey={(r) => r.garment.id} columns={columns({ selectable, selectedIds, toggle })} />
      )}
      {selected.length > 0 && <BulkBar selected={selected} onClear={() => setSelectedIds([])} />}
    </Stack>
  );
}
