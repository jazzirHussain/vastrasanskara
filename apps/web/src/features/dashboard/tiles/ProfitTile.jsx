import { Link } from 'react-router-dom';
import { Anchor, SimpleGrid, Stack, Text } from '@mantine/core';
import { formatINR } from '@vs/shared/money.js';
import { TileCard } from './TileCard.jsx';

function Orders({ title, list }) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={600}>
        {title}
      </Text>
      {list.map((o) => (
        <Anchor key={o.orderId} component={Link} to={`/orders/${o.orderId}`} size="sm" style={{ display: 'flex', justifyContent: 'space-between', minHeight: 32 }}>
          <span>{o.orderNo}</span>
          <span className="vs-figures">{formatINR(o.profit)}</span>
        </Anchor>
      ))}
    </Stack>
  );
}

/** Profit as a sum (sales less materials less running costs), and the lowest and highest orders. */
export function ProfitTile({ tile, filters }) {
  const p = tile.metrics?.profit;
  const orders = tile.metrics?.order_profits;
  return (
    <TileCard title="Profit" explain="Sales before GST, less materials used and running costs." tile={tile} metric="profit" filters={filters}>
      {p && (
        <Text className="vs-figures" size="sm">
          {formatINR(p.revenue)} sales − {formatINR(p.material)} materials − {formatINR(p.expenses)} running costs ={' '}
          <Text span fw={700} style={{ whiteSpace: 'nowrap' }}>
            {p.profit < 0 ? `a loss of ${formatINR(-p.profit)}` : `${formatINR(p.profit)} profit`}
          </Text>
        </Text>
      )}
      {orders?.count > 0 && (
        <SimpleGrid cols={2} mt="sm">
          <Orders title="Lowest" list={orders.lowest} />
          <Orders title="Highest" list={orders.highest} />
        </SimpleGrid>
      )}
    </TileCard>
  );
}
