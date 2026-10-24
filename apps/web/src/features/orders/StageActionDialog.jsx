import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  NativeSelect,
  NumberInput,
  Radio,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { todayYmd } from '../../components/DateLabel.jsx';
import { PhotoUploads } from '../../components/PhotoUploads.jsx';
import { useVendors, useWorkers } from '../workshop/workshopApi.js';
import { useStageAction } from './ordersApi.js';
import { actingStage, actionLabel, reworkTargets, stageName } from './stageSteps.js';

const WITH_WORKERS = new Set(['start', 'complete', 'qc_pass', 'qc_fail', 'rework', 'alteration']);
const WITH_PHOTOS = new Set(['start', 'complete', 'qc_pass', 'qc_fail', 'rework', 'alteration', 'sent_to_vendor', 'returned_from_vendor', 'skip']);
const WITH_REASON = new Set(['skip', 'rejected']);
const REWORK = new Set(['qc_fail', 'rework']);
const CHARGEABLE = new Set(['qc_fail', 'rework', 'alteration']);

const RESOLUTIONS = [
  ['refund', 'Refund the client'],
  ['remake', 'Make it again'],
  ['write_off', 'Write it off'],
];

const keysOf = (photos) => photos.map((p) => p.key ?? p);

/**
 * Records one stage action on `garments` (one, or several at the same stage from the
 * production board), asking only for what the action needs. `onDone` runs after it is saved.
 */
export function StageActionDialog({ action, garments, onClose, onDone }) {
  const { can } = useAuth();
  const [first] = garments;
  const run = useStageAction();
  const workers = useWorkers({ active: true });
  const vendors = useVendors({ active: true });
  const [form, setForm] = useState({
    workerIds: [],
    remarks: '',
    photos: [],
    reason: '',
    reworkStage: '',
    vendorId: '',
    dueBackDate: '',
    resolution: 'refund',
    chargeable: false,
    charge: '',
  });
  const [missing, setMissing] = useState({});
  const set = (changes) => {
    run.reset();
    setForm((f) => ({ ...f, ...changes }));
  };
  const priced = CHARGEABLE.has(action) && form.chargeable && can('money.view');

  function check() {
    const issues = {};
    if (WITH_REASON.has(action) && !form.reason.trim()) issues.reason = 'Say why';
    if (REWORK.has(action) && !form.reworkStage) issues.reworkStage = 'Choose the stage to rework';
    if (action === 'sent_to_vendor' && !form.vendorId) issues.vendorId = 'Choose a vendor';
    if (action === 'sent_to_vendor' && !form.dueBackDate) issues.dueBackDate = 'Choose the day it is due back';
    setMissing(issues);
    return Object.keys(issues).length === 0;
  }

  function body() {
    return {
      action,
      stage: actingStage(first, action),
      garments: garments.map(({ id, version }) => ({ id, version })),
      ...(WITH_WORKERS.has(action) && form.workerIds.length > 0 && { workerIds: form.workerIds }),
      ...(form.remarks.trim() && { remarks: form.remarks.trim() }),
      ...(form.photos.length > 0 && { photoKeys: keysOf(form.photos) }),
      ...(WITH_REASON.has(action) && { reason: form.reason.trim() }),
      ...(REWORK.has(action) && { reworkStage: form.reworkStage }),
      ...(action === 'sent_to_vendor' && { vendorId: form.vendorId, dueBackDate: form.dueBackDate }),
      ...(action === 'rejected' && { resolution: form.resolution }),
      ...(CHARGEABLE.has(action) && { chargeable: form.chargeable }),
      ...(priced && form.charge !== '' && { chargeAmount: Math.round(Number(form.charge) * 100) }),
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!check()) return;
    try {
      await run.mutateAsync(body());
      onDone?.();
      onClose();
    } catch {
      // Shown below from run.error.
    }
  }

  const subject = garments.length > 1 ? `${garments.length} garments` : first.garmentNo;

  return (
    <Modal opened onClose={onClose} title={`${actionLabel(action, first)} · ${subject}`}>
      <form onSubmit={handleSubmit} noValidate>
        <Stack>
          {run.error && (
            <Alert color="red">
              <Group justify="space-between">
                {run.error.message}
                {run.error.code === 'CONFLICT' && (
                  <Button
                    size="xs"
                    variant="white"
                    onClick={() => {
                      run.refresh();
                      onClose();
                    }}
                  >
                    Reload
                  </Button>
                )}
              </Group>
            </Alert>
          )}
          {REWORK.has(action) && (
            <NativeSelect
              label="Send back to"
              value={form.reworkStage}
              onChange={(e) => set({ reworkStage: e.currentTarget.value })}
              data={[{ value: '', label: 'Choose a stage' }, ...reworkTargets(first).map((s) => ({ value: s, label: stageName(s) }))]}
              error={missing.reworkStage}
            />
          )}
          {action === 'sent_to_vendor' && (
            <>
              <NativeSelect
                label="Vendor"
                value={form.vendorId}
                onChange={(e) => set({ vendorId: e.currentTarget.value })}
                data={[{ value: '', label: 'Pick a vendor' }, ...(vendors.data?.items ?? []).map((v) => ({ value: v.id, label: v.name }))]}
                error={missing.vendorId}
              />
              <TextInput
                label="Due back"
                type="date"
                min={todayYmd()}
                value={form.dueBackDate}
                onChange={(e) => set({ dueBackDate: e.currentTarget.value })}
                error={missing.dueBackDate}
              />
            </>
          )}
          {WITH_REASON.has(action) && (
            <TextInput label="Reason" value={form.reason} onChange={(e) => set({ reason: e.currentTarget.value })} error={missing.reason} />
          )}
          {action === 'rejected' && (
            <Radio.Group label="What happens now" value={form.resolution} onChange={(resolution) => set({ resolution })}>
              <Stack gap={6} mt={4}>
                {RESOLUTIONS.map(([value, label]) => (
                  <Radio key={value} value={value} label={label} />
                ))}
              </Stack>
            </Radio.Group>
          )}
          {WITH_WORKERS.has(action) && (workers.data?.items.length ?? 0) > 0 && (
            <Checkbox.Group label="Who worked on it" value={form.workerIds} onChange={(workerIds) => set({ workerIds })}>
              <Group gap="sm" mt={4}>
                {workers.data.items.map((w) => (
                  <Checkbox key={w.id} value={w.id} label={w.name} />
                ))}
              </Group>
            </Checkbox.Group>
          )}
          <Textarea label="Remarks" autosize minRows={2} value={form.remarks} onChange={(e) => set({ remarks: e.currentTarget.value })} />
          {WITH_PHOTOS.has(action) && (
            <PhotoUploads value={form.photos} onChange={(photos) => set({ photos })} purpose="stage_photo" label="Add photos" />
          )}
          {CHARGEABLE.has(action) && (
            <>
              <Switch
                label="Charge the client"
                checked={form.chargeable}
                onChange={(e) => set({ chargeable: e.currentTarget.checked })}
              />
              {priced && (
                <NumberInput
                  label="Charge (₹)"
                  min={0}
                  decimalScale={2}
                  value={form.charge}
                  onChange={(charge) => set({ charge })}
                />
              )}
              {form.chargeable && !can('money.view') && (
                <Text size="sm" c="var(--vs-muted)">
                  The front desk sets the amount when billing.
                </Text>
              )}
            </>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={run.isPending}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
