import { Alert, Group, Loader, Text } from '@mantine/core';
import { formatINR } from '@vs/shared/money.js';
import { useAuth } from '../../auth/AuthContext.js';
import { shortDate } from '../../components/DateLabel.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { showQty } from './qty.js';
import { useMovements } from './stockApi.js';

const MINUS = '−';

/** What happened, in plain words. */
export function movementLabel(m) {
  const garment = m.ref?.garmentNo;
  switch (m.type) {
    case 'opening':
      return 'Opening stock';
    case 'purchase_in':
      return m.quantity > 0 ? 'Delivery received' : 'Delivery undone';
    case 'reserve':
      return garment ? `Reserved for ${garment}` : 'Reserved for an order';
    case 'release':
      return 'Released';
    case 'consume':
      if (m.quantity > 0) return garment ? `Used for ${garment}` : 'Used for a garment';
      return garment ? `Put back from ${garment}` : 'Put back';
    case 'adjust':
      return 'Count correction';
    case 'sale':
      return m.quantity > 0 ? 'Sold on a bill' : 'Sale cancelled';
    default:
      return m.type;
  }
}

const signed = (n, text) => `${n < 0 ? MINUS : '+'}${text}`;

function quantityText(m, unit) {
  if (m.onHandChange !== 0) return signed(m.onHandChange, showQty(Math.abs(m.onHandChange), unit));
  return `${signed(m.reservedChange, showQty(Math.abs(m.reservedChange), unit))} reserved`;
}

/** The item's history, newest first, a page at a time. */
export function MovementList({ item }) {
  const { can } = useAuth();
  const money = can('money.view');
  const query = useMovements(item.id);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section aria-label="History">
      <Text fw={700} size="lg" mb={8}>
        History
      </Text>
      {query.isPending && <Loader />}
      {query.error && <Alert color="red">{query.error.message}</Alert>}
      {rows.length > 0 && (
        <div className="vs-panel" style={{ overflow: 'hidden' }}>
          {rows.map((m) => (
            <Group key={m.id} justify="space-between" wrap="nowrap" gap="sm" style={{ minHeight: 56, padding: '8px 12px', borderBottom: '1px solid var(--vs-rule)' }}>
              <div style={{ minWidth: 0 }}>
                <Text fw={600}>{movementLabel(m)}</Text>
                {m.reason && <Text size="sm">{m.reason}</Text>}
                <Text size="xs" c="var(--vs-muted)">
                  {[shortDate(m.date), m.by?.name].filter(Boolean).join(' · ')}
                </Text>
              </div>
              <div style={{ textAlign: 'right' }}>
                <Text fw={600} className="vs-figures">
                  {quantityText(m, item.usageUnit)}
                </Text>
                {money && Number.isSafeInteger(m.valueChange) && m.valueChange !== 0 && (
                  <Text size="sm" c="var(--vs-muted)" className="vs-figures">
                    {signed(m.valueChange, formatINR(Math.abs(m.valueChange)))}
                  </Text>
                )}
              </div>
            </Group>
          ))}
        </div>
      )}
      <LoadMore query={query} />
    </section>
  );
}
