import { useNavigate } from 'react-router-dom';
import { Text } from '@mantine/core';
import { HBars } from '../../../components/charts/HBars.jsx';
import { TileCard, barLink } from './TileCard.jsx';

/** Enquiries by how people heard of you, and how many became orders. */
export function EnquiriesTile({ tile, filters }) {
  const navigate = useNavigate();
  const figure = tile.metrics?.enquiry_sources;
  const rows = (figure?.breakdown ?? []).map((s) => ({
    key: s.key,
    label: s.label,
    value: s.count,
    display: `${s.count} · ${s.count ? Math.round((s.converted * 100) / s.count) : 0}% became orders`,
  }));
  return (
    <TileCard title="Enquiries" explain="Where enquiries came from this period." tile={tile} metric="enquiry_sources" filters={filters}>
      {rows.length ? (
        <HBars label="Enquiries by source" rows={rows} onSelect={(key) => navigate(barLink('enquiry_sources', filters, key))} />
      ) : (
        <Text c="var(--vs-muted)">No enquiries in this period.</Text>
      )}
    </TileCard>
  );
}
