import { useState } from 'react';
import {
  Alert,
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
import { Dropzone } from '@mantine/dropzone';
import { IconPhotoPlus } from '@tabler/icons-react';
import { istDate } from '@vs/shared/fy.js';
import { useAuth } from '../../../auth/AuthContext.js';
import { shortDate } from '../../../components/DateLabel.jsx';
import { uploadFile } from '../../../lib/upload.js';
import { MeasurementForm } from '../../customers/MeasurementForm.jsx';
import { useRecordMeasurement } from '../../customers/customersApi.js';

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

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
  };
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

function References({ garment, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  async function drop(files) {
    setError(null);
    setUploading(true);
    try {
      const added = [];
      for (const file of files) added.push({ key: await uploadFile(file, 'garment_reference'), name: file.name });
      onChange([...garment.referenceKeys, ...added].slice(0, 10));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <Dropzone onDrop={drop} accept={ACCEPT} maxSize={10 * 1024 * 1024} loading={uploading} p="sm" radius="sm">
        <Group gap="xs" justify="center" style={{ pointerEvents: 'none' }}>
          <IconPhotoPlus size={20} stroke={1.6} color="var(--vs-muted)" aria-hidden="true" />
          <Text size="sm" c="var(--vs-muted)">
            Add reference photos or sketches
          </Text>
        </Group>
      </Dropzone>
      {error && <Alert color="red" mt="xs">{error}</Alert>}
      {garment.referenceKeys.length > 0 && (
        <Group gap={6} mt={6}>
          {garment.referenceKeys.map((r, i) => (
            <Group key={r.key ?? r} gap={2} className="vs-panel" px={8} py={2}>
              <Text size="xs">{r.name ?? `Photo ${i + 1}`}</Text>
              <CloseButton
                size="xs"
                aria-label={`Remove ${r.name ?? `photo ${i + 1}`}`}
                onClick={() => onChange(garment.referenceKeys.filter((_, j) => j !== i))}
              />
            </Group>
          ))}
        </Group>
      )}
    </div>
  );
}

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
                max={200}
                allowDecimal={false}
                value={g.quantity}
                onChange={(v) => setGarment(g.uid, { quantity: v === '' ? '' : Number(v) })}
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
          </Stack>
        </section>
      ))}
      <div>
        <Button variant="light" onClick={() => update({ garments: [...draft.garments, newGarment()] })}>
          Add another garment
        </Button>
      </div>
    </Stack>
  );
}
