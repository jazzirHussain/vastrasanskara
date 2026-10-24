import { Text, Title } from '@mantine/core';

/** The customer's orders; filled in once the orders screens exist. */
export function CustomerOrders() {
  return (
    <section aria-label="Orders" style={{ marginTop: 32 }}>
      <Title order={3} mb="xs">
        Orders
      </Title>
      <Text c="var(--vs-muted)">Orders for this customer will appear here.</Text>
    </section>
  );
}
