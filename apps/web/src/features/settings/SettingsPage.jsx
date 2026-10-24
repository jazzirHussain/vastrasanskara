import { useState } from 'react';
import { Alert, Button, Group, Loader, Stack, Tabs, Title } from '@mantine/core';
import { fieldErrors } from '../../lib/fieldErrors.js';
import { AppointmentsTab } from './AppointmentsTab.jsx';
import { BusinessTab } from './BusinessTab.jsx';
import { MoneyTab } from './MoneyTab.jsx';
import { NotificationsTab } from './NotificationsTab.jsx';
import { NumberingTab } from './NumberingTab.jsx';
import { ProductionTab } from './ProductionTab.jsx';
import { useBranch, useSaveSettings, useSettings } from './settingsApi.js';

const SETTINGS_TABS = [
  ['money', 'Money', MoneyTab],
  ['production', 'Production', ProductionTab],
  ['appointments', 'Appointments', AppointmentsTab],
  ['notifications', 'Notifications', NotificationsTab],
  ['numbering', 'Numbering', NumberingTab],
];

/**
 * Drafts live here (not in the tabs) so edits survive switching tabs. Business details save
 * to /v1/branch from their own tab; everything else saves together to /v1/settings.
 */
function SettingsForm({ settings, branch }) {
  const [tab, setTab] = useState('business');
  const [values, setValues] = useState(settings);
  const [branchDraft, setBranchDraft] = useState(branch);
  const saveSettings = useSaveSettings();
  const errors = fieldErrors(saveSettings.error);

  const set = (key, value) => {
    saveSettings.reset();
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
            <TabComponent values={values} set={set} errors={errors} />
            <Group justify="flex-end">
              <Button
                loading={saveSettings.isPending}
                onClick={() => saveSettings.mutate(values, { onSuccess: (saved) => setValues(saved) })}
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
    <Stack>
      <Title order={2}>Settings</Title>
      {(settings.isPending || branch.isPending) && <Loader />}
      {settings.error && <Alert color="red">{settings.error.message}</Alert>}
      {settings.data && !branch.isPending && <SettingsForm settings={settings.data} branch={branch.data ?? null} />}
    </Stack>
  );
}
