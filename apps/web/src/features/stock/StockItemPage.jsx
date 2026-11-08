import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Anchor, Button, Group, Loader, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconChevronLeft } from '@tabler/icons-react';
import { formatINR } from '@vs/shared/money.js';
import { useAuth } from '../../auth/AuthContext.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { CountDialog } from './CountDialog.jsx';
import { ItemModal } from './ItemModal.jsx';
import { MovementList } from './MovementList.jsx';
import { ReceiveDialog } from './ReceiveDialog.jsx';
import { showQty, showUnitCost } from './qty.js';
import { useStockItem } from './stockApi.js';

function Figure({ label, milli, unit, alert = false }) {
  return (
    <div className="vs-panel" style={{ padding: '12px 16px' }}>
      <Text size="sm" c="var(--vs-muted)">
        {label}
      </Text>
      <Text fw={700} style={{ fontSize: 28, lineHeight: 1.2 }} className="vs-figures" c={alert ? 'red.8' : undefined}>
        {showQty(milli, unit)}
      </Text>
    </div>
  );
}

/** One stock item: what is in stock, reserved and free, its value (money.view), counting and its history. */
export function StockItemPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const query = useStockItem(id);
  const [dialog, setDialog] = useState(null);
  const it = query.data;
  if (query.isPending) return <Loader />;
  if (query.error) return <Alert color="red">{query.error.message}</Alert>;
  const canWrite = can('stock.write');
  const sub = [it.brand, it.colour, it.category].filter(Boolean).join(' · ');

  return (
    <>
      <Anchor component={Link} to="/stock" size="sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 44 }}>
        <IconChevronLeft size={16} aria-hidden="true" /> Stock
      </Anchor>
      <PageHeader
        title={it.name}
        action={
          canWrite && (
            <Group gap="xs">
              <Button size="md" onClick={() => setDialog('count')}>
                Count stock
              </Button>
              <Button size="md" variant="default" onClick={() => setDialog('receive')}>
                Receive delivery
              </Button>
              <Button size="md" variant="default" onClick={() => setDialog('edit')}>
                Edit
              </Button>
            </Group>
          )
        }
      >
        <Group gap="xs">
          {sub && <span>{sub}</span>}
          {it.low && <StatusBadge status="late" label="Running low" />}
          {!it.active && <StatusBadge status="inactive" label="Not in use" />}
        </Group>
      </PageHeader>
      <Stack gap="lg">
        <SimpleGrid cols={{ base: 1, xs: 3 }}>
          <Figure label="In stock" milli={it.onHand} unit={it.usageUnit} />
          <Figure label="Reserved for orders" milli={it.reserved} unit={it.usageUnit} />
          <Figure label="Free" milli={it.free} unit={it.usageUnit} alert={it.low} />
        </SimpleGrid>
        {can('money.view') && Number.isSafeInteger(it.value) && (
          <Text>{`Stock value ${formatINR(it.value)} · Average cost ${showUnitCost(it.avgCost, it.usageUnit)}`}</Text>
        )}
        {it.reorderLevel > 0 && (
          <Text size="sm" c="var(--vs-muted)">
            {`Reorder when free stock falls below ${showQty(it.reorderLevel, it.usageUnit)}`}
          </Text>
        )}
        <MovementList item={it} />
      </Stack>
      {dialog === 'count' && <CountDialog item={it} onClose={() => setDialog(null)} />}
      {dialog === 'edit' && <ItemModal item={it} onClose={() => setDialog(null)} />}
      {dialog === 'receive' && <ReceiveDialog item={it} onClose={() => setDialog(null)} />}
    </>
  );
}
