import { Link } from 'react-router-dom';
import { Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import {
  IconAlertTriangle, IconBuildingStore, IconCalendarEvent, IconChevronRight, IconClockExclamation, IconPackage, IconPhoneCall,
  IconPlayerPause, IconReceiptRupee, IconRosetteDiscountCheck,
} from '@tabler/icons-react';
import { METRICS } from '@vs/shared/dashboard.js';
import { ATTENTION, UNAVAILABLE, notFilteredText } from './copy.js';
import { filterQuery } from './dashboardApi.js';

const ICONS = {
  late_garments: IconClockExclamation,
  pickups_at_risk: IconAlertTriangle,
  fittings_today: IconCalendarEvent,
  overdue_bills: IconReceiptRupee,
  qc_failed: IconRosetteDiscountCheck,
  low_stock: IconPackage,
  vendor_overdue: IconBuildingStore,
  follow_ups_due: IconPhoneCall,
  on_hold_orders: IconPlayerPause,
};

/** "Needs attention today": only what has something in it, as plain sentences that open the list. */
export function AttentionList({ tile, filters }) {
  const order = Object.keys(METRICS).filter((id) => METRICS[id].tile === 'attention');
  const items = tile?.metrics ? order.filter((id) => tile.metrics[id]?.count > 0) : [];
  const note = notFilteredText(tile?.notFilteredBy);
  return (
    <section aria-label="Needs attention today" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Needs attention today</h2>
      {tile?.error && <Text c="var(--vs-muted)">{UNAVAILABLE}</Text>}
      {tile?.metrics && items.length === 0 && <Text c="var(--vs-muted)">Nothing needs you right now.</Text>}
      {items.length > 0 && (
        <Paper withBorder radius="md">
          <Stack gap={0}>
            {items.map((id, i) => {
              const Icon = ICONS[id];
              return (
                <UnstyledButton
                  key={id}
                  component={Link}
                  to={`/home/${id}?${filterQuery(filters)}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 56, padding: '0 12px', borderTop: i ? '1px solid var(--vs-rule)' : 0 }}
                >
                  <Icon size={22} aria-hidden color="var(--vs-indigo)" />
                  <Text style={{ flex: 1 }}>{ATTENTION[id](tile.metrics[id])}</Text>
                  <IconChevronRight size={18} aria-hidden color="var(--vs-muted)" />
                </UnstyledButton>
              );
            })}
          </Stack>
        </Paper>
      )}
      {note && (
        <Text size="xs" c="var(--vs-muted)" mt={6}>
          {note}
        </Text>
      )}
    </section>
  );
}
