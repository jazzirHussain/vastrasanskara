import { useState } from 'react';
import { Button } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useAuth } from '../../auth/AuthContext.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { ItemModal } from './ItemModal.jsx';
import { ItemsTab } from './ItemsTab.jsx';

/** Stock: the items on the shelves, running-low first. */
export function StockPage() {
  const { can } = useAuth();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [adding, setAdding] = useState(false);
  const canWrite = can('stock.write');
  const addButton = (
    <Button size={phone ? 'lg' : 'md'} fullWidth={phone} onClick={() => setAdding(true)}>
      Add item
    </Button>
  );
  return (
    <>
      <PageHeader title="Stock" action={canWrite && !phone ? addButton : null} />
      <div style={{ paddingBottom: phone && canWrite ? 168 : 0 }}>
        <ItemsTab onOrderMore={canWrite ? () => {} : null} />
      </div>
      {phone && canWrite && (
        <div style={{ position: 'fixed', left: 16, right: 16, bottom: 'calc(72px + env(safe-area-inset-bottom))', zIndex: 20 }}>{addButton}</div>
      )}
      {adding && <ItemModal onClose={() => setAdding(false)} />}
    </>
  );
}
