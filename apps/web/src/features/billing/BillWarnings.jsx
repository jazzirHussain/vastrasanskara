import { Link } from 'react-router-dom';
import { Alert, Anchor, Stack, Text } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';

const lineList = (numbers) => {
  if (numbers.length === 1) return `line ${numbers[0]}`;
  return `lines ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
};

/** Moves to a line's field so the fix is one tap away. */
function GoTo({ fieldId, children }) {
  return (
    <Anchor
      component="button"
      type="button"
      fw={600}
      size="sm"
      onClick={() => {
        const field = document.getElementById(fieldId);
        field?.scrollIntoView({ block: 'center' });
        field?.focus();
      }}
    >
      {children}
    </Anchor>
  );
}

function Banner({ children, action }) {
  return (
    <Alert color="haldi" variant="light" styles={{ message: { color: 'var(--vs-ink)' } }}>
      <Text size="sm">{children}</Text>
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </Alert>
  );
}

/**
 * What stops the draft from being issued, in plain words with a way to fix each:
 * lines without an item or a price (from the form as it is now), and the bill's own warnings
 * from the server (customer address, the boutique's GSTIN, a garment no longer billable).
 * `lines` are the form's lines with their check results; `warnings` the server's.
 */
export function BillWarnings({ lines, warnings, customerId }) {
  const { can } = useAuth();
  const numbered = lines.map((l, i) => ({ ...l, n: i + 1 }));
  const noItem = numbered.filter((l) => l.check.warnings.item);
  const noPrice = numbered.filter((l) => l.check.warnings.price);
  const keys = new Map(numbered.map((l) => [l.line.key, l]));
  const gone = warnings.filter((w) => w.code === 'GARMENT_NOT_BILLABLE' && keys.has(w.lineKey)).map((w) => keys.get(w.lineKey));
  const has = (code) => warnings.some((w) => w.code === code);
  const items = [];

  if (noItem.length) {
    items.push(
      <Banner key="item" action={<GoTo fieldId={`line-${noItem[0].line.key}-item`}>Choose now</GoTo>}>
        Choose what to bill {lineList(noItem.map((l) => l.n))} as.
      </Banner>,
    );
  }
  if (noPrice.length) {
    items.push(
      <Banner key="price" action={<GoTo fieldId={`line-${noPrice[0].line.key}-price`}>Enter the price</GoTo>}>
        Enter the price on {lineList(noPrice.map((l) => l.n))}.
      </Banner>,
    );
  }
  if (gone.length) {
    items.push(
      <Banner key="gone">
        The garment on {lineList(gone.map((l) => l.n))} was rejected or cancelled, or is already billed. Remove that line.
      </Banner>,
    );
  }
  if (has('ADDRESS_REQUIRED')) {
    items.push(
      <Banner
        key="address"
        action={
          <Anchor component={Link} to={`/customers/${customerId}`} fw={600} size="sm">
            Open the customer
          </Anchor>
        }
      >
        Add the customer’s address — needed for bills of ₹50,000 or more.
      </Banner>,
    );
  }
  if (has('BRANCH_GSTIN_MISSING')) {
    items.push(
      can('settings.edit') ? (
        <Banner
          key="gstin"
          action={
            <Anchor component={Link} to="/settings" fw={600} size="sm">
              Open Settings
            </Anchor>
          }
        >
          Add the boutique’s GSTIN in Settings before issuing bills.
        </Banner>
      ) : (
        <Banner key="gstin">The boutique’s GSTIN is missing. Ask the owner to add it in Settings before issuing bills.</Banner>
      ),
    );
  }
  if (!items.length) return null;
  return (
    <Stack gap="xs" mb="md">
      {items}
    </Stack>
  );
}

/** Server warnings that block issuing while the lines they name are still on the bill. */
export function blockingWarnings(warnings, lineKeys) {
  return warnings.filter(
    (w) => w.code === 'ADDRESS_REQUIRED' || w.code === 'BRANCH_GSTIN_MISSING' || (w.code === 'GARMENT_NOT_BILLABLE' && lineKeys.has(w.lineKey)),
  );
}
