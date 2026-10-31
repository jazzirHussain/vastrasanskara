import { useState } from 'react';
import { Alert, Button, Group, Loader, Stack, Tabs } from '@mantine/core';
import { PageHeader } from '../../components/PageHeader.jsx';
import { fieldErrors } from '../../lib/fieldErrors.js';
import { AppointmentsTab } from './AppointmentsTab.jsx';
import { BusinessTab } from './BusinessTab.jsx';
import { ExpensesTab } from './ExpensesTab.jsx';
import { GarmentTypesTab } from './GarmentTypesTab.jsx';
import { MoneyTab } from './MoneyTab.jsx';
import { NotificationsTab } from './NotificationsTab.jsx';
import { NumberingTab } from './NumberingTab.jsx';
import { ProductionTab } from './ProductionTab.jsx';
import { useBranch, useSaveSettings, useSettings } from './settingsApi.js';

const SETTINGS_TABS = [
  ['money', 'Money', MoneyTab],
  ['expenses', 'Expenses', ExpensesTab],
  ['garment-types', 'Garment types', GarmentTypesTab],
  ['production', 'Production', ProductionTab],
  ['appointments', 'Appointments', AppointmentsTab],
  ['notifications', 'Notifications', NotificationsTab],
  ['numbering', 'Numbering', NumberingTab],
];

// Structural equality for settings values (plain JSON; key order does not matter).
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => sameValue(a[k], b[k]));
}

/** The top-level settings in `values` that differ from `saved`. */
function changedSettings(values, saved) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => !sameValue(value, saved[key])));
}

/**
 * Drafts live here (not in the tabs) so edits survive switching tabs. Business details save
 * to /v1/branch from their own tab; everything else saves to /v1/settings, sending only the
 * settings changed since they were loaded or last saved.
 */
function SettingsForm({ settings, branch }) {
  const [tab, setTab] = useState('business');
  const [values, setValues] = useState(settings);
  const [saved, setSaved] = useState(settings);
  const [noChanges, setNoChanges] = useState(false);
  const [branchDraft, setBranchDraft] = useState(branch);
  const saveSettings = useSaveSettings();
  const errors = fieldErrors(saveSettings.error);

  const set = (key, value) => {
    saveSettings.reset();
    setNoChanges(false);
    setValues((v) => ({ ...v, [key]: value }));
  };

  return (
    <Tabs value={tab} onChange={setTab} keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab value="business">Business</Tabs.Tab>
        {SETTINGS_TABS.map(([value, label]) => (
          <Tabs.Tab key={value} value={value}>
            {label}
          </Tabs.Tab>
        ))}
      </Tabs.List>

      <Tabs.Panel value="business" pt="md">
        {branchDraft ? (
          <BusinessTab draft={branchDraft} setDraft={setBranchDraft} />
        ) : (
          <Alert color="red">Could not load the business details.</Alert>
        )}
      </Tabs.Panel>

      {SETTINGS_TABS.map(([value, , TabComponent]) => (
        <Tabs.Panel key={value} value={value} pt="md">
          <Stack>
            {saveSettings.error && (
              <Alert color="red">
                {saveSettings.error.code === 'VALIDATION_FAILED'
                  ? 'Some fields need attention.'
                  : saveSettings.error.message}
              </Alert>
            )}
            {saveSettings.isSuccess && <Alert color="green">Settings saved.</Alert>}
            {noChanges && <Alert color="gray">No changes to save.</Alert>}
            <TabComponent values={values} set={set} errors={errors} />
            <Group justify="flex-end">
              <Button
                loading={saveSettings.isPending}
                onClick={() => {
                  const changes = changedSettings(values, saved);
                  if (Object.keys(changes).length === 0) {
                    saveSettings.reset();
                    setNoChanges(true);
                    return;
                  }
                  saveSettings.mutate(changes, {
                    onSuccess: (result) => {
                      const next = { ...values, ...result };
                      setValues(next);
                      setSaved(next);
                    },
                  });
                }}
              >
                Save
              </Button>
            </Group>
          </Stack>
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const branch = useBranch();

  return (
    <Stack gap={0}>
      <PageHeader title="Settings" />
      {(settings.isPending || branch.isPending) && <Loader />}
      {settings.error && <Alert color="red">{settings.error.message}</Alert>}
      {settings.data && !branch.isPending && <SettingsForm settings={settings.data} branch={branch.data ?? null} />}
    </Stack>
  );
}
