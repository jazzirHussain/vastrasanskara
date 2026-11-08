import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Anchor, Group, Loader, SimpleGrid, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { formatINR } from '@vs/shared/money.js';
import { useAuth } from '../../auth/AuthContext.js';
import { showQty } from '../stock/qty.js';
import { useOrderCosts } from './costingApi.js';

const MINUS = '−';
/** Paise with a real minus sign for a loss. */
const money = (paise) => (paise < 0 ? `${MINUS}${formatINR(-paise)}` : formatINR(paise));

function Figure({ label, paise, loss = false }) {
  return (
    <div>
      <Text size="xs" c="var(--vs-muted)">
        {label}
      </Text>
      <Text fw={600} className="vs-figures" c={loss ? 'kumkum.8' : undefined} data-loss={loss ? 'true' : undefined}>
        {money(paise)}
      </Text>
    </div>
  );
}

function Breakdown({ garment: g }) {
  return (
    <section aria-label={`Costs of ${g.garmentNo}`} style={{ padding: '8px 0 4px 12px', borderLeft: '2px solid var(--vs-rule)' }}>
      {g.sharedRevenue > 0 && <Text size="sm">{`Billed includes ${formatINR(g.sharedRevenue)} shared from the order's other lines`}</Text>}
      <Text size="sm" fw={600} mt={4}>
        Materials
      </Text>
      {g.materials.length === 0 && (
        <Text size="sm" c="var(--vs-muted)">
          None used
        </Text>
      )}
      {g.materials.map((m) => (
        <Group key={m.stockItemId} justify="space-between" gap="xs">
          <Text size="sm">{`${m.name} — ${showQty(m.quantity, m.usageUnit)}`}</Text>
          <Text size="sm" className="vs-figures">
            {formatINR(m.cost)}
          </Text>
        </Group>
      ))}
      <Text size="sm" fw={600} mt={6}>
        Other costs
      </Text>
      {g.expenses.length === 0 && (
        <Text size="sm" c="var(--vs-muted)">
          None
        </Text>
      )}
      {g.expenses.map((e) => (
        <Group key={e.expenseId} justify="space-between" gap="xs">
          <Anchor component={Link} to={`/expenses/${e.expenseId}`} size="sm">
            {e.number}
          </Anchor>
          <Text size="sm" className="vs-figures">
            {formatINR(e.share)}
          </Text>
        </Group>
      ))}
    </section>
  );
}

function GarmentRow({ garment: g }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-garment={g.id} style={{ borderTop: '1px solid var(--vs-rule)', padding: '10px 0' }}>
      <UnstyledButton onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44 }}>
        {open ? <IconChevronDown size={16} aria-hidden="true" /> : <IconChevronRight size={16} aria-hidden="true" />}
        <Text fw={600} className="vs-figures">
          {g.garmentNo}
        </Text>
        <Text c="var(--vs-muted)">{g.description}</Text>
      </UnstyledButton>
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs" mt={4}>
        <Figure label="Billed" paise={g.revenue} />
        <Figure label="Materials cost" paise={g.material} />
        <Figure label="Other costs" paise={g.expense} />
        <Figure label="Margin" paise={g.margin} loss={g.margin < 0} />
      </SimpleGrid>
      {g.revenue === 0 && g.status !== 'cancelled' && (
        <Text size="xs" c="var(--vs-muted)" mt={2}>
          Not billed yet — margin will change
        </Text>
      )}
      {open && <Breakdown garment={g} />}
    </div>
  );
}

/**
 * "Costs and profit" (admin): the order's profit, folded; opened, each garment's billed value,
 * materials cost, other costs and margin, and tapping a garment lists what made up its costs.
 */
export function OrderCosts({ orderId }) {
  const { can } = useAuth();
  const query = useOrderCosts(orderId);
  const [open, setOpen] = useState(false);
  if (!can('costing.view')) return null;
  const costs = query.data;
  const profit = costs?.order.margin ?? 0;
  return (
    <section aria-label="Costs and profit" className="vs-panel" style={{ padding: '12px 16px' }}>
      <Group justify="space-between" wrap="wrap">
        <UnstyledButton onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44 }}>
          {open ? <IconChevronDown size={18} aria-hidden="true" /> : <IconChevronRight size={18} aria-hidden="true" />}
          <Text fw={700}>Costs and profit</Text>
        </UnstyledButton>
        {costs && (
          <Text fw={700} size="lg" className="vs-figures" c={profit < 0 ? 'kumkum.8' : undefined} data-loss={profit < 0 ? 'true' : undefined}>
            {profit < 0 ? `Loss ${formatINR(-profit)}` : `Profit ${formatINR(profit)}`}
          </Text>
        )}
      </Group>
      {query.isPending && <Loader size="sm" />}
      {query.error && <Alert color="red">{query.error.message}</Alert>}
      {open && costs && (
        <Stack gap={0} mt="xs">
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs" mb="xs">
            <Figure label="Billed" paise={costs.order.revenue} />
            <Figure label="Materials cost" paise={costs.order.material} />
            <Figure label="Other costs" paise={costs.order.expense} />
            <Figure label="Margin" paise={costs.order.margin} loss={costs.order.margin < 0} />
          </SimpleGrid>
          {costs.garments.map((g) => (
            <GarmentRow key={g.id} garment={g} />
          ))}
        </Stack>
      )}
    </section>
  );
}
