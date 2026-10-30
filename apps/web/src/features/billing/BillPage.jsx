import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Anchor, Button, Group, Loader, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { toMilli } from '@vs/shared/gst.js';
import { formatINR, mulDivRound } from '@vs/shared/money.js';
import { useAuth } from '../../auth/AuthContext.js';
import { shortDate } from '../../components/DateLabel.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { billErrorMessage } from '../../lib/errorMessages.js';
import { useCatalogItems } from '../catalog/catalogApi.js';
import { BillLines, DiscountField } from './BillLines.jsx';
import { BillTotals } from './BillTotals.jsx';
import { BillWarnings, blockingWarnings } from './BillWarnings.jsx';
import { useDeleteDraft, useInvoice, useOrderMoney, useSaveDraft } from './billingApi.js';
import { billBadge } from './billStatus.js';
import { checkForm, formFrom, previewTotals, toBody } from './draftForm.js';
import { IssueDialog } from './IssueDialog.jsx';
import { PdfButtons } from './PdfButtons.jsx';
import { TakePaymentDialog } from './TakePaymentDialog.jsx';

const usePhone = () => useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });

function Who({ invoice }) {
  return (
    <Group gap="sm" wrap="wrap">
      <Anchor component={Link} to={`/customers/${invoice.customer.id}`} fw={600}>
        {invoice.customer.name}
      </Anchor>
      {invoice.order && (
        <Anchor component={Link} to={`/orders/${invoice.order.id}`} c="var(--vs-muted)">
          Order {invoice.order.orderNo}
        </Anchor>
      )}
    </Group>
  );
}

function DeleteDraft({ invoice }) {
  const navigate = useNavigate();
  // Leave the page first, then forget the bill: the page never flashes "not found".
  const remove = useDeleteDraft(invoice.id, { onDeleted: () => navigate(invoice.order ? `/orders/${invoice.order.id}` : '/') });
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="subtle" color="kumkum" onClick={() => setOpen(true)}>
        Delete draft
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title="Delete this draft bill?" centered>
        <Stack>
          <Text size="sm">Nothing has been billed yet. The garments stay on the order and can be billed later.</Text>
          {remove.error && <Alert color="red">{billErrorMessage(remove.error)}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>
              Keep draft
            </Button>
            <Button
              color="kumkum"
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete draft
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/**
 * The draft as staff edit it. The form lives here; every change is checked and totalled at
 * once, and saved (PUT with `version`) when a field is left or a choice is made. Saves run one
 * at a time; a save with nothing new is skipped.
 */
function DraftBill(props) {
  const { can } = useAuth();
  if (!can('billing.draft')) return <ReadOnlyDraft invoice={props.invoice} />;
  return <EditableDraft {...props} />;
}

/** A draft for staff who see money but may not make bills: what is on it, nothing to change. */
function ReadOnlyDraft({ invoice }) {
  return (
    <Stack gap={0} maw={880}>
      <PageHeader title="Draft bill">
        <Who invoice={invoice} />
      </PageHeader>
      <Stack gap="lg">
        <Text size="sm" c="var(--vs-muted)">
          Only staff who make bills can change this draft.
        </Text>
        <IssuedLines lines={invoice.lines} />
        <BillTotals
          draft
          totals={invoice.totals}
          rates={invoice.lines.map((l) => l.gstRateBp ?? 0)}
          interState={invoice.placeOfSupply.interState}
          unavailable={invoice.totals ? null : { missing: 'item' }}
        />
      </Stack>
    </Stack>
  );
}

function EditableDraft(props) {
  const catalog = useCatalogItems();
  if (catalog.isPending) return <Loader />;
  if (catalog.error) return <Alert color="red">{catalog.error.message}</Alert>;
  return <DraftForm {...props} allItems={catalog.data.items} />;
}

function DraftForm({ invoice, allItems, onIssue, onReload }) {
  const { can } = useAuth();
  const phone = usePhone();
  const orderMoney = useOrderMoney(invoice.order?.id, { enabled: Boolean(invoice.order) });
  const save = useSaveDraft(invoice.id);
  const [form, setForm] = useState(() => formFrom(invoice));
  const [showBillDiscount, setShowBillDiscount] = useState(Boolean(invoice.invoiceDiscount));
  const formRef = useRef(form);
  const versionRef = useRef(invoice.version);
  const savedRef = useRef(JSON.stringify(toBody(formRef.current)));
  const queue = useRef(Promise.resolve(true));

  const itemsById = useMemo(() => new Map(allItems.map((i) => [i.id, i])), [allItems]);
  const activeItems = useMemo(() => allItems.filter((i) => i.active), [allItems]);
  const checked = checkForm(form);
  const preview = previewTotals(form, checked, itemsById, invoice.placeOfSupply.interState);
  const lineKeys = new Set(form.lines.map((l) => l.key));
  const blocking = blockingWarnings(invoice.warnings, lineKeys);
  const canDiscount = can('discounts.give');

  /** Saves the form as it is now, after any save already running. Resolves true once saved. */
  function commit() {
    const run = async () => {
      const current = formRef.current;
      const check = checkForm(current);
      if (!check.canSave) return false;
      const body = toBody(current, check);
      const json = JSON.stringify(body);
      if (json === savedRef.current) return true;
      try {
        const saved = await save.mutateAsync({ version: versionRef.current, ...body });
        versionRef.current = saved.version;
        savedRef.current = json;
        return true;
      } catch {
        return false;
      }
    };
    queue.current = queue.current.then(run);
    return queue.current;
  }

  const update = (changes, commitNow = false) => {
    const next = { ...formRef.current, ...changes };
    formRef.current = next;
    setForm(next);
    if (commitNow) commit();
  };

  async function startIssue() {
    if (await commit()) onIssue({ version: versionRef.current, total: preview.calc.totals.total });
  }

  const ready = checked.canIssue && preview.calc && blocking.length === 0 && !save.isPending;
  const rates = preview.calc?.lines.map((l) => l.rateBp) ?? [];

  return (
    <Stack gap={0} maw={880}>
      <PageHeader title="Draft bill">
        <Who invoice={invoice} />
      </PageHeader>

      {save.error?.code === 'CONFLICT' ? (
        <Alert color="haldi" mb="md">
          <Group justify="space-between">
            <Text size="sm">Someone else changed this bill. Reload to see their changes.</Text>
            <Button size="xs" variant="white" color="haldi" onClick={onReload}>
              Reload
            </Button>
          </Group>
        </Alert>
      ) : (
        save.error && (
          <Alert color="red" mb="md">
            {billErrorMessage(save.error)}
          </Alert>
        )
      )}

      <BillWarnings lines={form.lines.map((line, i) => ({ line, check: checked.lines[i] }))} warnings={invoice.warnings} customerId={invoice.customer.id} />

      <Stack gap="lg">
        <BillLines
          lines={form.lines}
          checks={checked.lines}
          items={activeItems}
          itemsById={itemsById}
          canDiscount={canDiscount}
          onChange={(lines, commitNow) => update({ lines }, commitNow)}
          onCommit={() => commit()}
        />

        {canDiscount &&
          (showBillDiscount ? (
            <div className="vs-panel" style={{ padding: 16, display: 'grid', gap: 12 }} onBlur={() => commit()}>
              <DiscountField
                idPrefix="bill"
                label="Discount on the whole bill"
                discount={form.billDiscount}
                base={checked.lines.reduce((s, l) => s + (l.amount ?? 0), 0)}
                errors={checked.billErrors}
                onChange={(billDiscount) => update({ billDiscount })}
              />
            </div>
          ) : (
            <Button variant="subtle" onClick={() => setShowBillDiscount(true)} style={{ alignSelf: 'flex-start' }}>
              Give a discount on the whole bill
            </Button>
          ))}

        <Textarea
          label="Note on the bill (optional)"
          autosize
          minRows={2}
          value={form.notes}
          onChange={(e) => update({ notes: e.currentTarget.value })}
          onBlur={() => commit()}
        />

        <BillTotals
          draft
          totals={preview.calc?.totals}
          rates={rates}
          interState={invoice.placeOfSupply.interState}
          advance={orderMoney.data?.advanceHeld ?? 0}
          unavailable={preview.calc ? null : preview}
        />

        {can('billing.issue') ? (
          <Stack gap={6}>
            <Button size="lg" fullWidth={phone} onClick={startIssue} disabled={!ready} loading={save.isPending} style={phone ? undefined : { alignSelf: 'flex-start' }}>
              Issue bill
            </Button>
            {!ready && !save.isPending && (
              <Text size="sm" c="var(--vs-muted)">
                Fix the notes in yellow and red above to issue this bill.
              </Text>
            )}
          </Stack>
        ) : (
          <Text size="sm" c="var(--vs-muted)">
            Ask the owner or the front desk to issue this bill.
          </Text>
        )}
        {can('billing.draft') && (
          <Group>
            <DeleteDraft invoice={invoice} />
          </Group>
        )}
      </Stack>
    </Stack>
  );
}

/** The lines as printed: description, quantity × price, discount, amount before GST. */
function IssuedLines({ lines }) {
  return (
    <div className="vs-stack" role="list" aria-label="Lines">
      {lines.map((l) => {
        const gross = mulDivRound(l.rate, toMilli(l.quantity), 1000);
        return (
          <div key={l.key} role="listitem" className="vs-stack-row" style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <Text fw={600}>{l.description}</Text>
              <Text size="sm" c="var(--vs-muted)" className="vs-figures">
                {l.quantity} × {formatINR(l.rate)}
                {l.discount > 0 && ` · discount ${formatINR(l.discount)}`}
              </Text>
            </div>
            <span className="vs-figures" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
              {formatINR(gross - l.discount)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** An issued or cancelled bill, exactly as printed: nothing on it can be changed. */
function IssuedBill({ invoice }) {
  const { can } = useAuth();
  const [paying, setPaying] = useState(false);
  const badge = billBadge(invoice);
  const issued = invoice.status === 'issued';
  const rates = invoice.lines.map((l) => l.gstRateBp ?? 0);
  const owed = issued ? (invoice.settlement?.balance ?? 0) : 0;
  return (
    <Stack gap={0} maw={880}>
      <PageHeader title={invoice.number}>
        <Group gap="sm" wrap="wrap">
          <StatusBadge status={badge.status} label={badge.label} />
          <Text span c="var(--vs-muted)">
            {shortDate(invoice.date)}
          </Text>
          <Who invoice={invoice} />
        </Group>
      </PageHeader>

      {invoice.cancellation && (
        <Alert color="gray" mb="md" title="Cancelled">
          {invoice.cancellation.reason}
        </Alert>
      )}

      <Stack gap="lg">
        <PdfButtons docId={invoice.id} number={invoice.number} />
        {owed > 0 && can('payments.record') && (
          <Button size="lg" onClick={() => setPaying(true)} style={{ alignSelf: 'flex-start' }}>
            Take payment
          </Button>
        )}
        <IssuedLines lines={invoice.lines} />
        <BillTotals
          totals={invoice.totals}
          rates={rates}
          interState={invoice.placeOfSupply.interState}
          settlement={issued ? invoice.settlement : null}
          amountInWords={invoice.amountInWords}
        />
        {issued && invoice.dueDate && invoice.settlement?.balance > 0 && (
          <Text fw={600} c={invoice.overdue ? 'var(--vs-kumkum)' : undefined}>
            Pay by {shortDate(invoice.dueDate)}
            {invoice.overdue && ' — overdue'}
          </Text>
        )}
      </Stack>
      {paying && (
        <TakePaymentDialog customer={invoice.customer} invoice={invoice} defaultAmount={owed} billBalance={owed} onDone={() => setPaying(false)} />
      )}
    </Stack>
  );
}

/** /bills/:id — a draft to fill in and issue, or an issued bill to print and share. */
export function BillPage() {
  const { id } = useParams();
  const invoice = useInvoice(id);
  const [issuing, setIssuing] = useState(null);
  const [formKey, setFormKey] = useState(0);

  if (invoice.isPending) return <Loader />;
  if (invoice.error) return <Alert color="red">{invoice.error.message}</Alert>;
  const inv = invoice.data;
  const reload = async () => {
    await invoice.refetch();
    setFormKey((k) => k + 1);
  };

  return (
    <>
      {inv.status === 'draft' ? (
        <DraftBill key={formKey} invoice={inv} onIssue={setIssuing} onReload={reload} />
      ) : (
        <IssuedBill invoice={inv} />
      )}
      {issuing && (
        <IssueDialog
          invoiceId={inv.id}
          version={issuing.version}
          total={issuing.total}
          onClose={() => {
            setIssuing(null);
            if (inv.status === 'draft') reload();
          }}
        />
      )}
    </>
  );
}
