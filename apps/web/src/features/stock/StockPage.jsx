import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Tabs } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useAuth } from '../../auth/AuthContext.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { ItemModal } from './ItemModal.jsx';
import { ItemsTab } from './ItemsTab.jsx';
import { RequestModal } from './RequestModal.jsx';
import { ToBuyTab } from './ToBuyTab.jsx';

/** Stock: the items on the shelves (running low first) and the "To buy" list. Tab and filter live in the address (`?tab=to-buy&status=received`). */
export function StockPage() {
  const { can } = useAuth();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'to-buy' ? 'to-buy' : 'items';
  const status = params.get('status') === 'received' ? 'received' : 'open';
  const [adding, setAdding] = useState(false);
  const [ordering, setOrdering] = useState(null);
  const canWrite = can('stock.write');
  const showAdd = canWrite && tab === 'items';
  const addButton = (
    <Button size={phone ? 'lg' : 'md'} fullWidth={phone} onClick={() => setAdding(true)}>
      Add item
    </Button>
  );
  const go = (next) => setParams(next, { replace: true });

  return (
    <>
      <PageHeader title="Stock" action={showAdd && !phone ? addButton : null} />
      <Tabs value={tab} onChange={(t) => go(t === 'to-buy' ? { tab: 'to-buy' } : {})} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="items" fz="md">
            Items
          </Tabs.Tab>
          <Tabs.Tab value="to-buy" fz="md">
            To buy
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="items" style={{ paddingBottom: phone && showAdd ? 168 : 0 }}>
          <ItemsTab onOrderMore={canWrite ? setOrdering : null} />
        </Tabs.Panel>
        <Tabs.Panel value="to-buy">
          <ToBuyTab status={status} onStatus={(s) => go(s === 'received' ? { tab: 'to-buy', status: 'received' } : { tab: 'to-buy' })} />
        </Tabs.Panel>
      </Tabs>
      {phone && showAdd && (
        <div style={{ position: 'fixed', left: 16, right: 16, bottom: 'calc(72px + env(safe-area-inset-bottom))', zIndex: 20 }}>{addButton}</div>
      )}
      {adding && <ItemModal onClose={() => setAdding(false)} />}
      {ordering && <RequestModal item={ordering} reason="low_stock" onClose={() => setOrdering(null)} />}
    </>
  );
}
