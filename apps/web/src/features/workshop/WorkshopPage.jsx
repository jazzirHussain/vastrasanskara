import { useState } from 'react';
import { Stack, Tabs } from '@mantine/core';
import { PageHeader } from '../../components/PageHeader.jsx';
import { VendorsTab } from './VendorsTab.jsx';
import { WorkersTab } from './WorkersTab.jsx';

/** The house's workers and the vendors it sends work to. */
export function WorkshopPage() {
  const [tab, setTab] = useState('workers');
  return (
    <Stack gap={0}>
      <PageHeader title="Workshop" />
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="workers">Workers</Tabs.Tab>
          <Tabs.Tab value="vendors">Vendors</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="workers">
          <WorkersTab />
        </Tabs.Panel>
        <Tabs.Panel value="vendors">
          <VendorsTab />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
