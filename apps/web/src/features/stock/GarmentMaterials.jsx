import { useState } from 'react';
import { ActionIcon, Alert, Button, Group, Loader, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconTrash } from '@tabler/icons-react';
import { STAGE_KEYS } from '@vs/shared';
import { useAuth } from '../../auth/AuthContext.js';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { ItemPicker } from './ItemPicker.jsx';
import { QtyStepper } from './QtyStepper.jsx';
import { showQty } from './qty.js';
import { useChangeUsed, useGarmentMaterials, useSetGarmentMaterials } from './stockApi.js';

const MATERIALS_READY = STAGE_KEYS.indexOf('materials_ready');

/** Whether the user may see and change garment materials (quantities only). */
export const canUseMaterials = (can) => can('stock.write') || can('stock.consume.own');

/**
 * Planned materials as a list of steppers with "Add material": `lines` are { stockItemId, name,
 * usageUnit, step, quantity }; `shortOf(stockItemId, quantity)` may answer how much is still to buy.
 */
export function MaterialLinesEditor({ lines, onChange, shortOf = () => 0 }) {
  const [picking, setPicking] = useState(false);
  const setLine = (id, quantity) => onChange(lines.map((l) => (l.stockItemId === id ? { ...l, quantity } : l)));
  return (
    <Stack gap="xs">
      {lines.map((l) => {
        const short = shortOf(l.stockItemId, l.quantity);
        return (
          <div key={l.stockItemId} data-material={l.stockItemId} style={{ borderBottom: '1px solid var(--vs-rule)', paddingBottom: 6 }}>
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text fw={600} style={{ minWidth: 0 }}>
                {l.name}
              </Text>
              <ActionIcon variant="subtle" color="kumkum" size={44} aria-label={`Remove ${l.name}`} onClick={() => onChange(lines.filter((x) => x.stockItemId !== l.stockItemId))}>
                <IconTrash size={18} />
              </ActionIcon>
            </Group>
            <QtyStepper value={l.quantity} onChange={(q) => setLine(l.stockItemId, q)} step={l.step} min={l.step} unit={l.usageUnit} label={l.name} />
            {short > 0 && (
              <Text size="sm" fw={600} c="haldi.9" data-alert="short">
                {`${showQty(short, l.usageUnit)} to buy`}
              </Text>
            )}
          </div>
        );
      })}
      {picking ? (
        <ItemPicker
          exclude={lines.map((l) => l.stockItemId)}
          onPick={(it) => {
            onChange([...lines, { stockItemId: it.id, name: it.name, usageUnit: it.usageUnit, step: it.step, quantity: it.step }]);
            setPicking(false);
          }}
        />
      ) : (
        <div>
          <Button variant="light" size="md" onClick={() => setPicking(true)}>
            Add material
          </Button>
        </div>
      )}
    </Stack>
  );
}

const planOf = (card) =>
  card.lines.filter((l) => l.state === 'planned').map((l) => ({ stockItemId: l.stockItemId, name: l.name, usageUnit: l.usageUnit, step: l.step, quantity: l.planned }));
const sameLines = (a, b) => JSON.stringify(a.map((l) => [l.stockItemId, l.quantity])) === JSON.stringify(b.map((l) => [l.stockItemId, l.quantity]));

function PlanCard({ garmentId, card }) {
  const save = useSetGarmentMaterials(garmentId);
  const [draft, setDraft] = useState(() => ({ version: card.version, lines: planOf(card) }));
  // A newer card (saved here or elsewhere) replaces the draft.
  if (draft.version !== card.version) setDraft({ version: card.version, lines: planOf(card) });
  const saved = planOf(card);
  const dirty = !sameLines(draft.lines, saved);
  const shortOf = (id, quantity) => {
    const line = card.lines.find((l) => l.stockItemId === id && l.state === 'planned');
    return line && line.planned === quantity ? line.short : 0;
  };
  return (
    <Stack gap="sm">
      <MaterialLinesEditor lines={draft.lines} onChange={(lines) => setDraft((d) => ({ ...d, lines }))} shortOf={shortOf} />
      {save.error && <Alert color="red">{save.error.message}</Alert>}
      {dirty && (
        <Group gap="xs">
          <Button size="md" loading={save.isPending} onClick={() => save.mutate({ version: card.version, lines: draft.lines.map(({ stockItemId, quantity }) => ({ stockItemId, quantity })) })}>
            Save materials
          </Button>
          <Button size="md" variant="default" disabled={save.isPending} onClick={() => setDraft({ version: card.version, lines: saved })}>
            Undo changes
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function UsedChange({ garmentId, card, line, direction, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const change = useChangeUsed(garmentId);
  const max = direction < 0 ? line.used : Infinity;
  const [quantity, setQuantity] = useState(Math.min(line.step, max));
  const [note, setNote] = useState('');
  const title = `${direction > 0 ? 'Used more' : 'Put back'} — ${line.name}`;
  const save = async () => {
    try {
      await change.mutateAsync({ version: card.version, changes: [{ stockItemId: line.stockItemId, change: direction * quantity }], note: note.trim() });
      onClose();
    } catch {
      // Shown below.
    }
  };
  return (
    <Modal opened title={title} centered={!phone} fullScreen={phone} onClose={change.isPending ? () => {} : onClose}>
      <Stack gap="md">
        <Text>{direction > 0 ? 'How much more was used?' : `How much went back to the shelf? (used ${showQty(line.used, line.usageUnit)})`}</Text>
        <QtyStepper value={quantity} onChange={(q) => setQuantity(Math.min(q, max))} step={line.step} min={Math.min(line.step, max)} unit={line.usageUnit} label={line.name} />
        <TextInput label="Note (optional)" maxLength={300} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        {change.error && <Alert color="red">{change.error.message}</Alert>}
        <Group justify="flex-end" grow={phone}>
          <Button variant="default" size="md" onClick={onClose} disabled={change.isPending}>
            Go back
          </Button>
          <Button size="md" loading={change.isPending} disabled={quantity <= 0} onClick={save}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function UsedCard({ garmentId, card }) {
  const [sheet, setSheet] = useState(null);
  const used = card.lines.filter((l) => l.state === 'used');
  if (!used.length) {
    return (
      <Text size="sm" c="var(--vs-muted)">
        No materials were listed for this garment.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {used.map((l) => (
        <div key={l.stockItemId} data-material={l.stockItemId} style={{ borderBottom: '1px solid var(--vs-rule)', paddingBottom: 6 }}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <div>
              <Text fw={600}>{l.name}</Text>
              <Text size="sm">{`Used ${showQty(l.used, l.usageUnit)}`}</Text>
            </div>
            <Group gap="xs">
              <Button variant="default" size="md" onClick={() => setSheet({ line: l, direction: 1 })}>
                Used more
              </Button>
              <Button variant="default" size="md" disabled={l.used <= 0} onClick={() => setSheet({ line: l, direction: -1 })}>
                Put back
              </Button>
            </Group>
          </Group>
        </div>
      ))}
      {sheet && <UsedChange garmentId={garmentId} card={card} line={sheet.line} direction={sheet.direction} onClose={() => setSheet(null)} />}
    </Stack>
  );
}

/**
 * The garment's "Materials" card: before Materials ready, the planned list (reserved from stock;
 * a line short of stock says how much is to buy); afterwards, what was used with "Used more" and
 * "Put back". Quantities only: never a price.
 */
export function GarmentMaterials({ garment }) {
  const { can } = useAuth();
  const allowed = canUseMaterials(can);
  const query = useGarmentMaterials(garment.id, { enabled: allowed });
  if (!allowed) return null;
  const card = query.data;
  const pastMaterialsReady = STAGE_KEYS.indexOf(garment.currentStage) > MATERIALS_READY;
  const usedMode = Boolean(card?.lines.some((l) => l.state === 'used')) || pastMaterialsReady;
  const live = garment.status === 'in_progress' || garment.status === 'ready';
  if (card && !live && card.lines.length === 0) return null;
  return (
    <section aria-label="Materials" style={{ background: 'var(--vs-chalk)', borderRadius: 6, padding: '10px 12px' }}>
      <Text fw={600} mb={6}>
        Materials
      </Text>
      {query.isPending && <Loader size="sm" />}
      {query.error && <Alert color="red">{query.error.message}</Alert>}
      {card && usedMode && <UsedCard garmentId={garment.id} card={card} />}
      {card && !usedMode && live && <PlanCard garmentId={garment.id} card={card} />}
      {card && !usedMode && !live && (
        // A cancelled or rejected garment's materials went back to the shelf: nothing to change.
        <Text size="sm" c="var(--vs-muted)">
          {planOf(card).map((l) => `${l.name} ${showQty(l.quantity, l.usageUnit)}`).join(' · ') || 'No materials.'}
        </Text>
      )}
    </section>
  );
}
