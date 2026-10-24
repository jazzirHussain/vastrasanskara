import { useState } from 'react';
import { Anchor, Button, Group, Stack, Text } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { DateLabel } from '../../components/DateLabel.jsx';
import { Money } from '../../components/Money.jsx';
import { StageThread } from '../../components/StageThread.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { apiFetch } from '../../lib/api.js';
import { isOpen } from './orderStatus.js';
import { PlanEditor } from './PlanEditor.jsx';

async function openFile(key) {
  const { url } = await apiFetch('/v1/files/url', { query: { key } });
  window.open(url, '_blank', 'noopener');
}

function Fact({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div>
      <Text size="xs" c="var(--vs-muted)">
        {label}
      </Text>
      <Text style={{ whiteSpace: 'pre-wrap' }}>{children}</Text>
    </div>
  );
}

/** One garment: its details on the left, the full stage thread on the right. */
export function GarmentPanel({ order, garment, typeLabel, late }) {
  const { can } = useAuth();
  const [adjusting, setAdjusting] = useState(false);
  const canAdjust = isOpen(order) && (can('production.update') || can('orders.write'));

  return (
    <section className="vs-panel" style={{ padding: 20 }} aria-label={garment.description}>
      <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <Stack gap="sm">
          <div>
            <Text size="xs" c="var(--vs-muted)" className="vs-figures">
              {garment.garmentNo}
            </Text>
            <Text fw={600} size="lg">
              {garment.description}
            </Text>
            <Group gap={6} mt={4}>
              <Text size="sm" c="var(--vs-muted)">
                {typeLabel(garment.type)}
              </Text>
              {garment.status !== 'in_progress' && <StatusBadge status={garment.status} />}
              {garment.tightSchedule && garment.status === 'in_progress' && <StatusBadge status="tight" />}
              {late && <StatusBadge status="late" />}
              {garment.batchId && <StatusBadge status="batch" label="Part of a batch" />}
            </Group>
          </div>
          <Group gap="xl" align="flex-start">
            <div>
              <Text size="xs" c="var(--vs-muted)">
                Due
              </Text>
              <DateLabel ymd={garment.dueDate ?? order.pickupDate} done={!isOpen(order)} />
              {garment.originalDueDate && garment.dueDate !== garment.originalDueDate && (
                <Text size="xs" c="var(--vs-muted)">
                  Originally <DateLabel ymd={garment.originalDueDate} relative={false} />
                </Text>
              )}
            </div>
            {garment.agreedPrice !== undefined && (
              <div>
                <Text size="xs" c="var(--vs-muted)">
                  Agreed price
                </Text>
                <Money paise={garment.agreedPrice} />
              </div>
            )}
          </Group>
          <Fact label="Fabric">{garment.fabric}</Fact>
          <Fact label="Design notes">{garment.designNotes}</Fact>
          {garment.referenceKeys.length > 0 && (
            <div>
              <Text size="xs" c="var(--vs-muted)">
                Reference photos
              </Text>
              <Group gap="sm">
                {garment.referenceKeys.map((key, i) => (
                  <Anchor key={key} component="button" type="button" onClick={() => openFile(key)}>
                    Photo {i + 1}
                  </Anchor>
                ))}
              </Group>
            </div>
          )}
          {canAdjust && (
            <div>
              <Button variant="default" size="xs" onClick={() => setAdjusting(true)}>
                Adjust plan
              </Button>
            </div>
          )}
        </Stack>
        <StageThread
          variant="full"
          stagePlan={garment.stagePlan}
          currentStage={garment.currentStage}
          status={garment.status}
          tight={garment.tightSchedule}
          late={late}
        />
      </div>
      {adjusting && <PlanEditor orderId={order.id} garment={garment} opened onClose={() => setAdjusting(false)} />}
    </section>
  );
}
