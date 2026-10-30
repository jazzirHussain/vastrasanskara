import { useSearchParams } from 'react-router-dom';
import { Tabs } from '@mantine/core';
import { PageHeader } from '../../components/PageHeader.jsx';
import { BillsTab } from './BillsTab.jsx';
import { MoneyOwedTab } from './MoneyOwedTab.jsx';
import { PaymentsTab } from './PaymentsTab.jsx';

const TABS = ['owed', 'bills', 'payments'];

/** Bills: money owed (the default), every bill, and payments taken. The tab lives in `?tab=`. */
export function BillsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'owed';

  return (
    <>
      <PageHeader title="Bills" />
      <Tabs value={tab} onChange={(t) => setParams(t === 'owed' ? {} : { tab: t }, { replace: true })} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="owed">Money owed</Tabs.Tab>
          <Tabs.Tab value="bills">Bills</Tabs.Tab>
          <Tabs.Tab value="payments">Payments</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="owed">
          <MoneyOwedTab />
        </Tabs.Panel>
        <Tabs.Panel value="bills">
          <BillsTab />
        </Tabs.Panel>
        <Tabs.Panel value="payments">
          <PaymentsTab />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
