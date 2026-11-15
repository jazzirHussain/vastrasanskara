import { Stack, Text } from '@mantine/core';
import { formatINR } from '@vs/shared/money.js';
import { TileCard } from './TileCard.jsx';

/** Items running low, stock set aside for orders, and the items that made the most. */
export function StockTile({ tile, filters }) {
  const low = tile.metrics?.stock_low;
  const reserved = tile.metrics?.stock_reserved;
  const profit = tile.metrics?.stock_item_profit;
  return (
    <TileCard title="Stock" explain="What is running low and what stock is earning." tile={tile} metric="stock_low" filters={filters}>
      <Stack gap={6}>
        {low && <Text size="sm">{low.count === 1 ? '1 item is running low' : `${low.count} items are running low`}</Text>}
        {reserved && <Text size="sm">{formatINR(reserved.amount)} of stock set aside for orders</Text>}
        {profit?.top?.length > 0 && (
          <>
            <Text size="sm" fw={600} mt={4}>
              Best earners this period
            </Text>
            {profit.top.map((i) => (
              <Text key={i.key} size="sm" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{i.label}</span>
                <span className="vs-figures">{i.noSellingPrice ? 'No selling price' : formatINR(i.profit)}</span>
              </Text>
            ))}
          </>
        )}
      </Stack>
    </TileCard>
  );
}
