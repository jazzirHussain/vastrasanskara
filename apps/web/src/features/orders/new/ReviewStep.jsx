import { Group, Stack, Text, Title } from '@mantine/core';
import { DateLabel } from '../../../components/DateLabel.jsx';
import { Money } from '../../../components/Money.jsx';
import { ResponsiveTable } from '../../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../../components/StatusBadge.jsx';
import { displayPhone } from '../../customers/CustomersPage.jsx';

const toPaise = (rupees) => Math.round(Number(rupees) * 100);

function Fact({ label, children }) {
  return (
    <div>
      <Text size="xs" c="var(--vs-muted)">
        {label}
      </Text>
      <div>{children}</div>
    </div>
  );
}

/** Step 4: everything at a glance and the total of agreed prices. */
export function ReviewStep({ draft, garmentTypes, designers }) {
  const typeLabel = (key) => garmentTypes.find((t) => t.key === key)?.label ?? key;
  const designer = designers.find((d) => d.id === draft.designerId)?.name ?? '';
  const total = draft.garments.reduce((sum, g) => sum + toPaise(g.price) * g.quantity, 0);

  return (
    <section aria-label="Review">
      <Stack gap="lg">
        <div className="vs-panel" style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <Fact label="Customer">
            <Text fw={600}>{draft.customer.name}</Text>
            <Text size="sm" c="var(--vs-muted)" className="vs-figures">
              {displayPhone(draft.customer.phone)}
            </Text>
          </Fact>
          <Fact label="Designer">{designer}</Fact>
          <Fact label="Pickup">
            <DateLabel ymd={draft.pickupDate} />
          </Fact>
          {draft.occasionDate && (
            <Fact label="Occasion">
              <DateLabel ymd={draft.occasionDate} relative={false} />
            </Fact>
          )}
          {draft.priority === 'rush' && (
            <Fact label="Priority">
              <StatusBadge status="rush" />
            </Fact>
          )}
        </div>

        <div>
          <Title order={3} mb="sm">
            Garments
          </Title>
          <ResponsiveTable
            label="Garments"
            rows={draft.garments}
            rowKey={(g) => g.uid}
            columns={[
              { key: 'description', header: 'Garment', primary: true, render: (g) => g.description },
              { key: 'type', header: 'Type', render: (g) => typeLabel(g.type) },
              { key: 'quantity', header: 'Pieces', align: 'right', render: (g) => <span className="vs-figures">{g.quantity}</span> },
              { key: 'due', header: 'Due', render: (g) => (g.dueDate ? <DateLabel ymd={g.dueDate} /> : 'With pickup') },
              { key: 'price', header: 'Price', align: 'right', render: (g) => <Money paise={toPaise(g.price) * g.quantity} /> },
            ]}
          />
          <Group justify="flex-end" mt="sm" gap="md">
            <Text c="var(--vs-muted)">Total of agreed prices</Text>
            <Text fw={700} size="lg">
              <Money paise={total} />
            </Text>
          </Group>
          {draft.expectedBudget !== '' && (
            <Group justify="flex-end" gap="md">
              <Text size="sm" c="var(--vs-muted)">
                Expected budget
              </Text>
              <Text size="sm">
                <Money paise={toPaise(draft.expectedBudget)} />
              </Text>
            </Group>
          )}
        </div>

        {draft.notes.trim() && (
          <Fact label="Notes for the workshop">
            <Text style={{ whiteSpace: 'pre-wrap' }}>{draft.notes}</Text>
          </Fact>
        )}
      </Stack>
    </section>
  );
}
