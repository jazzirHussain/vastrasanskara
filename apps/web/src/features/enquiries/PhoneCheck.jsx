import { Link, useNavigate } from 'react-router-dom';
import { Anchor, Button, Group, Text } from '@mantine/core';

/** Under the phone: "Already a customer: Priya" (a link) or "Open enquiry: Priya" with "Open it". */
export function PhoneCheck({ check }) {
  const navigate = useNavigate();
  if (!check) return null;
  const { customer, openEnquiry } = check;
  return (
    <div aria-live="polite">
      {customer && (
        <Text size="sm" mt={4}>
          Already a customer:{' '}
          <Anchor component={Link} to={`/customers/${customer.id}`}>
            {customer.name}
          </Anchor>
        </Text>
      )}
      {openEnquiry && (
        <Group gap="xs" mt={4}>
          <Text size="sm" c="var(--vs-kumkum)" fw={600}>
            Open enquiry: {openEnquiry.name}
          </Text>
          <Button size="compact-sm" variant="light" onClick={() => navigate(`/enquiries/${openEnquiry.id}`)}>
            Open it
          </Button>
        </Group>
      )}
    </div>
  );
}
