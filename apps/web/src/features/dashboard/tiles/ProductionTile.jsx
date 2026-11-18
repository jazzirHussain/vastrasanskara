import { useNavigate } from 'react-router-dom';
import { Text } from '@mantine/core';
import { HBars } from '../../../components/charts/HBars.jsx';
import { TileCard, barLink } from './TileCard.jsx';

/** Open garments per stage, with how many are in house and how many are with vendors. */
export function ProductionTile({ tile, filters }) {
  const navigate = useNavigate();
  const figure = tile.metrics?.stage_garments;
  const rows = (figure?.breakdown ?? [])
    .filter((s) => s.count > 0)
    .map((s) => ({ key: s.key, label: s.label, value: s.count, display: s.withVendor ? `${s.inHouse} in house · ${s.withVendor} with vendors` : `${s.count}` }));
  return (
    <TileCard title="Production" explain="Garments at each stage right now." tile={tile} metric="stage_garments" filters={filters}>
      {rows.length ? (
        <HBars label="Garments by stage" rows={rows} onSelect={(key) => navigate(barLink('stage_garments', filters, key))} />
      ) : (
        <Text c="var(--vs-muted)">No garments in progress.</Text>
      )}
    </TileCard>
  );
}
