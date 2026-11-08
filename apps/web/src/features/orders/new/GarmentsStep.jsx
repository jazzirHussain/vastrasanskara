import { useState } from 'react';
import {
  Button,
  CloseButton,
  Drawer,
  Group,
  NativeSelect,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { istDate } from '@vs/shared/fy.js';
import { useAuth } from '../../../auth/AuthContext.js';
import { shortDate } from '../../../components/DateLabel.jsx';
import { IMAGE_TYPES, PhotoUploads } from '../../../components/PhotoUploads.jsx';
import { MeasurementForm } from '../../customers/MeasurementForm.jsx';
import { useRecordMeasurement } from '../../customers/customersApi.js';
import { MaterialLinesEditor } from '../../stock/GarmentMaterials.jsx';

const ACCEPT = [...IMAGE_TYPES, 'application/pdf'];

/** A blank garment line. `measurementId` undefined means "the latest set for its type". */
export function newGarment() {
  return {
    uid: crypto.randomUUID(),
    type: 'blouse',
    description: '',
    fabric: '',
    designNotes: '',
    price: '',
    quantity: 1,
    dueDate: '',
    referenceKeys: [],
    materials: [],
  };
}

/** "Materials (optional)": folded until opened; a batch gives each of its garments the list. */
function GarmentMaterialsFold({ garment, onChange }) {
  const { can } = useAuth();
  const materials = garment.materials ?? [];
  const [open, setOpen] = useState(materials.length > 0);
  if (!can('stock.view') && !can('stock.consume.own')) return null;
  return (
    <div>
      <Button variant="subtle" size="compact-md" px={0} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Materials (optional)
      </Button>
      {open && (
        <Stack gap="xs" mt={6}>
          {garment.quantity > 1 && (
            <Text size="sm" c="var(--vs-indigo)">{`Each of the ${garment.quantity} garments gets these`}</Text>
          )}
          <MaterialLinesEditor lines={materials} onChange={onChange} />
        </Stack>
      )}
    </div>
  );
}

function Measurements({ garment, latest, customerId, garmentTypes, onChosen }) {
  const { can } = useAuth();
  const [taking, setTaking] = useState(false);
  const record = useRecordMeasurement(customerId);
  const set = garment.measurementId === undefined ? latest[garment.type] : garment.chosenMeasurement;

  return (
    <div style={{ background: 'var(--vs-chalk)', borderRadius: 6, padding: '10px 12px' }}>
      {set ? (
        <>
          <Text size="sm" fw={600}>
            Measurements taken {shortDate(istDate(new Date(set.takenAt)))}
          </Text>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', marginTop: 4 }}>
            {set.values.map((v) => (
              <Text key={v.name} size="sm" className="vs-figures">
                {`${v.name} ${v.value}${v.unit === 'in' ? '″' : ' cm'}`}
              </Text>
            ))}
          </div>
        </>
      ) : (
        <Text size="sm" c="var(--vs-muted)">
          No measurements for this garment type yet.
        </Text>
      )}
      {can('measurements.write') && (
        <Button variant="subtle" size="compact-sm" mt={6} px={0} onClick={() => setTaking(true)}>
          Take new measurements
        </Button>
      )}
      <Drawer opened={taking} onClose={() => { setTaking(false); record.reset(); }} title="Take measurements" position="right" size="md">
        {taking && (
          <MeasurementForm
            garmentTypes={garmentTypes}
            initialType={garment.type}
            mutation={record}
            onSaved={(m) => {
              onChosen(m);
              setTaking(false);
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

/** Reference photo uploads; `garment.referenceKeys` holds stored keys or `{ key, name }` for new ones. */
export function References({ garment, onChange }) {
  return (
    <PhotoUploads
      value={garment.referenceKeys}
      onChange={onChange}
      purpose="garment_reference"
      label="Add reference photos or sketches"
      accept={ACCEPT}
    />
  );
}

// The API's limits: pieces per batch and garment lines per order.
export const MAX_PIECES = 200;
export const MAX_GARMENT_LINES = 50;
export const canAddGarment = (garments) => garments.length < MAX_GARMENT_LINES;

/** Step 2: what is being made. A quantity above 1 is a batch of identical garments. */
export function GarmentsStep({ draft, update, garmentTypes, latest }) {
  const setGarment = (uid, changes) =>
    update({ garments: draft.garments.map((g) => (g.uid === uid ? { ...g, ...changes } : g)) });
  const remove = (uid) => update({ garments: draft.garments.filter((g) => g.uid !== uid) });

  return (
    <Stack gap="lg">
      {draft.garments.map((g, i) => (
        <section key={g.uid} className="vs-panel" style={{ padding: 20 }} aria-label={`Garment ${i + 1}`}>
          <Group justify="space-between" mb="sm">
            <Text fw={600}>Garment {i + 1}</Text>
            {draft.garments.length > 1 && <CloseButton aria-label={`Remove garment ${i + 1}`} onClick={() => remove(g.uid)} />}
          </Group>
          <Stack gap="sm">
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NativeSelect
                label="Garment type"
                data={garmentTypes.map((t) => ({ value: t.key, label: t.label }))}
                value={g.type}
                onChange={(e) => setGarment(g.uid, { type: e.currentTarget.value, measurementId: undefined, chosenMeasurement: undefined })}
              />
              <TextInput label="Description" placeholder="e.g. Bridal blouse, boat neck" value={g.description} onChange={(e) => setGarment(g.uid, { description: e.currentTarget.value })} />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <NumberInput
                label="Price per piece (₹)"
                min={0}
                thousandSeparator=","
                thousandsGroupStyle="lakh"
                decimalScale={2}
                value={g.price}
                onChange={(v) => setGarment(g.uid, { price: v })}
              />
              <NumberInput
                label="Identical pieces"
                min={1}
                max={MAX_PIECES}
                allowDecimal={false}
                value={g.quantity}
                onChange={(v) => setGarment(g.uid, { quantity: v === '' ? '' : Number(v) })}
                error={g.quantity > MAX_PIECES ? `At most ${MAX_PIECES} identical pieces per garment.` : undefined}
              />
              <TextInput label="Fabric" value={g.fabric} onChange={(e) => setGarment(g.uid, { fabric: e.currentTarget.value })} />
              <TextInput
                label="Own due date"
                title="Only if this garment is needed before the pickup date"
                type="date"
                value={g.dueDate}
                onChange={(e) => setGarment(g.uid, { dueDate: e.currentTarget.value })}
              />
            </SimpleGrid>
            {g.quantity > 1 && (
              <Text size="sm" c="var(--vs-indigo)" fw={500}>
                A batch of {g.quantity} identical pieces
              </Text>
            )}
            <Textarea label="Design notes" autosize minRows={2} value={g.designNotes} onChange={(e) => setGarment(g.uid, { designNotes: e.currentTarget.value })} />
            {draft.customer && (
              <Measurements
                garment={g}
                latest={latest}
                customerId={draft.customer.id}
                garmentTypes={garmentTypes}
                onChosen={(m) => setGarment(g.uid, { measurementId: m.id, chosenMeasurement: m })}
              />
            )}
            <References garment={g} onChange={(referenceKeys) => setGarment(g.uid, { referenceKeys })} />
            <GarmentMaterialsFold garment={g} onChange={(materials) => setGarment(g.uid, { materials })} />
          </Stack>
        </section>
      ))}
      {canAddGarment(draft.garments) ? (
        <div>
          <Button variant="light" onClick={() => update({ garments: [...draft.garments, newGarment()] })}>
            Add another garment
          </Button>
        </div>
      ) : (
        <Text size="sm" c="var(--vs-muted)">
          An order can hold up to {MAX_GARMENT_LINES} garments.
        </Text>
      )}
    </Stack>
  );
}
