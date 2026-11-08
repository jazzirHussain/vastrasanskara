import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Anchor, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { IconFile } from '@tabler/icons-react';
import { formatINR } from '@vs/shared/money.js';
import { istDate } from '@vs/shared/fy.js';
import { useAuth } from '../../auth/AuthContext.js';
import { Money } from '../../components/Money.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { longDate } from '../../lib/dates.js';
import { openFile } from '../../lib/upload.js';
import { MODE_LABELS } from '../billing/billStatus.js';
import { useFileUrl } from '../settings/settingsApi.js';
import { useExpense } from './expensesApi.js';
import { VoidExpenseDialog } from './VoidExpenseDialog.jsx';

const isPdf = (a) => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.name ?? '');
// Browsers cannot draw these as pictures, so they open from a tile.
const isTile = (a) => isPdf(a) || /heic|heif/i.test(`${a.contentType} ${a.name}`);
const dayOf = (iso) => longDate(istDate(new Date(iso)));

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '8px 0', borderBottom: '1px solid var(--vs-rule)' }}>
      <Text c="var(--vs-muted)">{label}</Text>
      <Text ta="right" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </div>
  );
}

function Photo({ attachment, onError }) {
  const [broken, setBroken] = useState(false);
  const tile = isTile(attachment) || broken;
  const url = useFileUrl(tile ? null : attachment.key);
  return (
    <Button
      variant="default"
      h={tile ? 56 : 88}
      w={tile ? undefined : 88}
      p={tile ? 'sm' : 0}
      aria-label={`Open ${attachment.name}`}
      onClick={() => openFile(attachment.key).catch((e) => onError(e.message))}
      leftSection={tile ? <IconFile size={22} aria-hidden /> : undefined}
    >
      {tile ? (
        isPdf(attachment) ? attachment.name : 'Photo of the bill — tap to open'
      ) : url.data?.url ? (
        <img src={url.data.url} alt="" onError={() => setBroken(true)} width={88} height={88} style={{ objectFit: 'cover', borderRadius: 6 }} />
      ) : (
        <Loader size="sm" />
      )}
    </Button>
  );
}

function GstBlock({ gst }) {
  return (
    <section aria-label="GST bill">
      <Text fw={600} mt="md">
        GST bill
      </Text>
      <Field label="Bill number">{gst.billNo}</Field>
      <Field label="Bill date">{longDate(gst.billDate)}</Field>
      <Field label="Before GST">
        <Money paise={gst.taxable} />
      </Field>
      {gst.cgst > 0 && (
        <Field label="CGST">
          <Money paise={gst.cgst} />
        </Field>
      )}
      {gst.sgst > 0 && (
        <Field label="SGST">
          <Money paise={gst.sgst} />
        </Field>
      )}
      {gst.igst > 0 && (
        <Field label="IGST">
          <Money paise={gst.igst} />
        </Field>
      )}
      <Field label="Can claim this GST back (ITC)">{gst.itcEligible ? 'Yes' : 'No'}</Field>
    </section>
  );
}

function LinkLine({ link, canOpenOrder }) {
  const label = link.label ?? '';
  const orderNo = link.orderNo ?? '';
  // The label already names the order ("Order VS/ORD/…") for an order link.
  const text = (orderNo && label.includes(orderNo) ? label : `Order ${orderNo}${label && label !== orderNo ? ` · ${label}` : ''}`).trim();
  return canOpenOrder ? (
    <Anchor component={Link} to={`/orders/${link.orderId}`}>
      {text}
    </Anchor>
  ) : (
    <span>{text}</span>
  );
}

/** One expense: what was paid, to whom, the GST bill, its photos and the order it belongs to. */
export function ExpensePage() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: expense, isPending, error } = useExpense(id);
  const [voiding, setVoiding] = useState(false);
  const [photoError, setPhotoError] = useState(null);

  if (isPending) return <Loader />;
  if (error || !expense) return <Alert color="red">{error?.message ?? 'This expense could not be found.'}</Alert>;

  const active = expense.status === 'active';
  const canChange = can('expenses.write') && active && !expense.monthLocked;
  const voided = expense.status === 'voided';
  return (
    <>
      <PageHeader title={expense.number}>
        <Group gap="sm">
          <span>{longDate(expense.date)}</span>
          {voided && <StatusBadge status="cancelled" label="Voided" />}
        </Group>
      </PageHeader>
      <Stack gap={0} maw={560}>
        <Text className="vs-figures" fw={700} mb="sm" style={{ fontSize: 34, lineHeight: 1.2, textDecoration: voided ? 'line-through' : undefined }}>
          {formatINR(expense.total)}
        </Text>
        {voided && expense.void && (
          <Alert color="gray" mb="sm" title={`Voided on ${dayOf(expense.void.at)}${expense.void.by?.name ? ` by ${expense.void.by.name}` : ''}`}>
            {`Reason: ${expense.void.reason}`}
          </Alert>
        )}
        <Field label="What for">{expense.category.label}</Field>
        <Field label="Paid to">{expense.payee.name}</Field>
        {expense.payee.gstin && <Field label="Their GSTIN">{expense.payee.gstin}</Field>}
        <Field label="How paid">{MODE_LABELS[expense.mode] ?? expense.mode}</Field>
        {expense.reference && <Field label="Reference">{expense.reference}</Field>}
        {expense.gst && <GstBlock gst={expense.gst} />}
        {expense.link && (
          <Field label="Linked to">
            <LinkLine link={expense.link} canOpenOrder={can('orders.read.own')} />
          </Field>
        )}
        {expense.source === 'purchase' && (
          <Field label="Came from">
            <span>From a stock delivery</span>
            {' · '}
            <Anchor component={Link} to="/stock?tab=to-buy&status=received">
              See deliveries in Stock
            </Anchor>
          </Field>
        )}
        {expense.note && <Field label="Note">{expense.note}</Field>}
        {expense.attachments.length > 0 && (
          <section aria-label="Photos of the bill">
            <Text fw={600} mt="md" mb="xs">
              Photo of the bill
            </Text>
            <Group gap="sm">
              {expense.attachments.map((a) => (
                <Photo key={a.key} attachment={a} onError={setPhotoError} />
              ))}
            </Group>
            {photoError && (
              <Text c="red" size="sm" mt="xs">
                {photoError}
              </Text>
            )}
          </section>
        )}
        <Text size="sm" c="var(--vs-muted)" mt="md">
          {`Added by ${expense.createdBy?.name ?? 'someone'} on ${dayOf(expense.createdAt)}`}
        </Text>
        {expense.updatedAt !== expense.createdAt && (
          <Text size="sm" c="var(--vs-muted)">{`Changed ${dayOf(expense.updatedAt)}`}</Text>
        )}
        {can('expenses.write') && active && expense.monthLocked && (
          <Alert color="yellow" mt="md">
            This month is locked for filing
          </Alert>
        )}
        {canChange && (
          <Group mt="lg" grow>
            <Button component={Link} to={`/expenses/${expense.id}/edit`} size="lg">
              Edit
            </Button>
            {/* A delivery's expense is voided by undoing the delivery in Stock. */}
            {expense.source !== 'purchase' && (
              <Button size="lg" variant="default" color="kumkum" onClick={() => setVoiding(true)}>
                Void expense
              </Button>
            )}
          </Group>
        )}
      </Stack>
      {voiding && <VoidExpenseDialog expense={expense} onClose={() => setVoiding(false)} />}
    </>
  );
}
