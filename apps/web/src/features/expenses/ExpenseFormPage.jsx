import { useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Alert, Anchor, Button, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { expenseSchema } from '@vs/shared/schemas/expenses.js';
import { formatINR } from '@vs/shared/money.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { todayYmd } from '../../components/DateLabel.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { useBranch, useSettings } from '../settings/settingsApi.js';
import { paiseOf } from '../billing/rupees.js';
import { AmountField } from './AmountField.jsx';
import { BillPhotos } from './BillPhotos.jsx';
import { CategoryChips, rememberCategory } from './CategoryChips.jsx';
import { changedFields, emptyExpenseForm, expenseToForm, formToBody } from './expenseForm.js';
import { useCreateExpense, useExpense, useUpdateExpense } from './expensesApi.js';
import { GstSection, gstIssues } from './GstSection.jsx';
import { LinkPicker } from './LinkPicker.jsx';
import { ModeButtons } from './ModeButtons.jsx';
import { PayeePicker } from './PayeePicker.jsx';

const MAY_BE_SAVED = 'This expense may already be saved. Check Expenses before trying again.';
const SAVE_ERRORS = { IDEMPOTENCY_IN_PROGRESS: MAY_BE_SAVED, IDEMPOTENCY_KEY_REUSED: MAY_BE_SAVED };

/** { 'payee.gstin': 'message' } from a failed schema check, the first message per field. */
function errorsOf(zodError) {
  const errors = {};
  for (const issue of zodError.issues) errors[issue.path.join('.')] ??= issue.message;
  return errors;
}

function ExpenseForm({ original, settings, branch }) {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const today = todayYmd();
  const editing = Boolean(original);
  // Made when the page opens and sent again on every retry, so a double tap or a dropped
  // connection never saves the expense twice.
  const [key] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState(() => (original ? expenseToForm(original) : emptyExpenseForm(today)));
  const [otherDay, setOtherDay] = useState(Boolean(original && original.date !== today));
  const [errors, setErrors] = useState({});
  const create = useCreateExpense();
  const update = useUpdateExpense(original?.id);
  const mutation = editing ? update : create;

  const options = { branchStateCode: branch.stateCode };
  const totalPaise = paiseOf(form.amount);
  const uploading = form.photos.some((p) => p.status === 'uploading');
  const failedPhoto = form.photos.some((p) => p.status === 'failed');
  const ready = totalPaise !== null && form.category !== '' && form.payee.name.trim() !== '';
  const issues = gstIssues(form, branch.stateCode);
  const changed = editing ? changedFields(form, original, options) : null;
  const edit = (patch) => {
    setErrors({});
    setForm((f) => ({ ...f, ...patch }));
  };

  const saving = useRef(false);
  async function save() {
    if (saving.current) return;
    saving.current = true;
    try {
      await doSave();
    } finally {
      saving.current = false;
    }
  }

  async function doSave() {
    const body = formToBody(form, options);
    const parsed = expenseSchema.safeParse(body);
    if (!parsed.success || issues.length > 0) {
      setErrors(parsed.success ? {} : errorsOf(parsed.error));
      return;
    }
    setErrors({});
    if (editing) {
      if (Object.keys(changed).length === 0) return navigate(`/expenses/${original.id}`);
      try {
        await update.mutateAsync({ ...changed, version: original.version });
      } catch {
        return;
      }
      notifications.show({ color: 'neem', message: 'Changes saved' });
      return navigate(`/expenses/${original.id}`);
    }
    let saved;
    try {
      saved = await create.mutateAsync({ body, key });
    } catch {
      return;
    }
    rememberCategory(form.category);
    const id = `expense-${saved.id}`;
    notifications.show({
      id,
      color: 'neem',
      autoClose: 10_000,
      message: (
        <Group justify="space-between" wrap="nowrap">
          <Text>{`${saved.number} saved`}</Text>
          <Button
            size="compact-md"
            variant="light"
            onClick={() => {
              notifications.hide(id);
              navigate('/expenses/new');
            }}
          >
            Add another
          </Button>
        </Group>
      ),
    });
    navigate(`/expenses?month=${form.date.slice(0, 7)}`);
  }

  const buttonLabel = editing
    ? 'Save changes'
    : uploading
      ? 'Uploading photo…'
      : totalPaise !== null
        ? `Save expense of ${formatINR(totalPaise)}`
        : 'Save expense';
  const messages = Object.values(errors);

  return (
    <Stack gap="lg" pb="xl">
      <PageHeader title={editing ? 'Edit expense' : 'Add expense'}>{editing ? original.number : null}</PageHeader>

      <AmountField
        value={form.amount}
        autoFocus={!editing}
        error={errors.total}
        onChange={(amount) => {
          setErrors({});
          // Figures worked out from the old total no longer fit.
          setForm((f) => ({ ...f, amount, gst: { ...f.gst, edited: f.gst.rateBp === null ? f.gst.edited : null } }));
        }}
      />

      <CategoryChips
        categories={settings.expenseCategories}
        current={original?.category}
        value={form.category}
        error={errors.category}
        onChange={(category) => edit({ category })}
      />

      <PayeePicker
        payee={form.payee}
        error={errors['payee.name']}
        onChange={(payee) => {
          setErrors({});
          setForm((f) => ({ ...f, payee, gst: { ...f.gst, gstin: payee.gstin ?? (f.payee.vendorId ? '' : f.gst.gstin) } }));
        }}
      />

      <ModeButtons mode={form.mode} reference={form.reference} onMode={(mode) => edit({ mode })} onReference={(reference) => edit({ reference })} />

      <BillPhotos photos={form.photos} setPhotos={(change) => setForm((f) => ({ ...f, photos: change(f.photos) }))} />

      {otherDay ? (
        <TextInput label="Date paid" type="date" size="md" max={today} value={form.date} error={errors.date} onChange={(e) => e.currentTarget.value && edit({ date: e.currentTarget.value })} />
      ) : (
        <Group gap="xs">
          <Text>Paid today</Text>
          <Anchor component="button" type="button" size="md" onClick={() => setOtherDay(true)}>
            Paid on another day?
          </Anchor>
        </Group>
      )}

      <GstSection form={form} setForm={(next) => { setErrors({}); setForm(next); }} branchStateCode={branch.stateCode} errors={errors} />

      <LinkPicker link={form.link} onChange={(link) => edit({ link })} />

      <TextInput label="Note (optional)" size="md" maxLength={300} value={form.note} onChange={(e) => edit({ note: e.currentTarget.value })} />

      <Stack
        gap="xs"
        style={{
          position: 'sticky',
          bottom: phone ? 'calc(64px + env(safe-area-inset-bottom))' : 0,
          zIndex: 5,
          background: 'var(--mantine-color-body)',
          padding: '12px 0',
          borderTop: '1px solid var(--vs-rule)',
        }}
      >
        {messages.length > 0 && (
          <Alert color="red" role="alert">
            {messages.map((m) => (
              <div key={m}>{m}</div>
            ))}
          </Alert>
        )}
        {failedPhoto && <Text c="red" size="sm">A photo did not upload. Remove it or add it again.</Text>}
        {mutation.error && <Alert color="red">{SAVE_ERRORS[mutation.error.code] ?? mutation.error.message}</Alert>}
        <Button size="xl" fullWidth loading={mutation.isPending} disabled={!ready || uploading || failedPhoto || (editing && Object.keys(changed).length === 0)} onClick={save}>
          {buttonLabel}
        </Button>
      </Stack>
    </Stack>
  );
}

function EditExpense({ id, settings, branch }) {
  const { data: expense, isPending, error } = useExpense(id);
  if (isPending) return <Loader />;
  if (error || !expense) return <Alert color="red">{error?.message ?? 'This expense could not be found.'}</Alert>;
  // A voided expense or one in a locked month cannot change: the detail page explains why.
  if (expense.status === 'voided' || expense.monthLocked) return <Navigate to={`/expenses/${id}`} replace />;
  return <ExpenseForm original={expense} settings={settings} branch={branch} />;
}

/** "Add expense" (/expenses/new) and "Edit expense" (/expenses/:id/edit): the whole flow on one screen. */
export function ExpenseFormPage() {
  const { id } = useParams();
  const location = useLocation();
  const settings = useSettings();
  const branch = useBranch();
  if (settings.isPending || branch.isPending) return <Loader />;
  if (settings.error || branch.error) return <Alert color="red">{(settings.error ?? branch.error).message}</Alert>;
  // A fresh key for every opening, so "Add another" starts a new expense.
  return id ? (
    <EditExpense key={location.key} id={id} settings={settings.data} branch={branch.data} />
  ) : (
    <ExpenseForm key={location.key} original={null} settings={settings.data} branch={branch.data} />
  );
}
