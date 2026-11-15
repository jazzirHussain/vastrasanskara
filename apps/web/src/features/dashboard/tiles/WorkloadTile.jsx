import { useNavigate } from 'react-router-dom';
import { Text } from '@mantine/core';
import { HBars } from '../../../components/charts/HBars.jsx';
import { TileCard, barLink } from './TileCard.jsx';

const onTimeText = (o) => (o?.rate === null || o?.rate === undefined ? '' : ` · ${Math.round(o.rate / 100)}% on time`);

/** Garments with each designer (and their on-time rate) and with each vendor. */
export function WorkloadTile({ tile, filters }) {
  const navigate = useNavigate();
  const designers = tile.metrics?.workload_designers;
  const vendors = tile.metrics?.workload_vendors;
  return (
    <TileCard title="Workload" explain="Open garments with each designer and vendor." tile={tile} metric="workload_designers" filters={filters}>
      {designers && (
        <HBars
          label="Garments with each designer"
          rows={designers.breakdown.map((d) => ({ key: d.key, label: d.label, value: d.count, display: `${d.count}${onTimeText(d.onTime)}` }))}
          onSelect={(key) => navigate(barLink('workload_designers', filters, key))}
        />
      )}
      {vendors?.breakdown?.length > 0 && (
        <>
          <Text size="sm" fw={600} mt="sm">
            With vendors
          </Text>
          <HBars
            label="Garments with each vendor"
            rows={vendors.breakdown.map((v) => ({ key: v.key, label: v.label, value: v.count, display: v.overdue ? `${v.count} · ${v.overdue} late` : `${v.count}` }))}
            onSelect={(key) => navigate(barLink('workload_vendors', filters, key))}
          />
        </>
      )}
    </TileCard>
  );
}
