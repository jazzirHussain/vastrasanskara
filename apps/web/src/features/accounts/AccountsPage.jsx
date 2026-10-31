import { useSearchParams } from 'react-router-dom';
import { Tabs } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { CheckRecordsTab } from './CheckRecordsTab.jsx';
import { MonthLocksTab } from './MonthLocksTab.jsx';

/** Accounts (owner only): month locks, and Check records for those who may verify. The tab lives in `?tab=`. */
export function AccountsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const canCheck = can('audit.verify');
  const tab = params.get('tab') === 'check' && canCheck ? 'check' : 'locks';

  return (
    <>
      <PageHeader title="Accounts" />
      <Tabs value={tab} onChange={(t) => setParams(t === 'locks' ? {} : { tab: t }, { replace: true })} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="locks">Month locks</Tabs.Tab>
          {canCheck && <Tabs.Tab value="check">Check records</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="locks">
          <MonthLocksTab />
        </Tabs.Panel>
        {canCheck && (
          <Tabs.Panel value="check">
            <CheckRecordsTab />
          </Tabs.Panel>
        )}
      </Tabs>
    </>
  );
}
