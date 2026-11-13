import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Chip, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { enquirySchema } from '@vs/shared/schemas/frontOffice.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { todayYmd } from '../../components/DateLabel.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { SOURCES } from '../customers/CustomerForm.jsx';
import { useSettings } from '../settings/settingsApi.js';
import { emptyEnquiryForm, formToEnquiryBody } from './enquiryForm.js';
import { useCreateEnquiry, usePhoneCheck } from './enquiriesApi.js';
import { FollowUpChips } from './FollowUpChips.jsx';
import { InterestChips } from './InterestChips.jsx';
import { PhoneCheck } from './PhoneCheck.jsx';

const MAY_BE_SAVED = 'This enquiry may already be saved. Check Enquiries before trying again.';
const SAVE_ERRORS = { IDEMPOTENCY_IN_PROGRESS: MAY_BE_SAVED, IDEMPOTENCY_KEY_REUSED: MAY_BE_SAVED };

function errorsOf(zodError) {
  const errors = {};
  for (const issue of zodError.issues) errors[issue.path.join('.')] ??= issue.message;
  return errors;
}

function EnquiryForm({ garmentTypes }) {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const today = todayYmd();
  // Made when the page opens and sent on every retry: a double tap never saves two enquiries.
  const [key] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState(() => emptyEnquiryForm(today));
  const [errors, setErrors] = useState({});
  const check = usePhoneCheck(form.phone);
  const create = useCreateEnquiry();
  const edit = (patch) => {
    setErrors({});
    setForm((f) => ({ ...f, ...patch }));
  };
  const openEnquiry = check.data?.openEnquiry ?? null;
  const ready = form.phone.trim() !== '' && form.name.trim() !== '' && !openEnquiry;

  const saving = useRef(false);
  async function save() {
    if (saving.current) return;
    const body = formToEnquiryBody(form);
    const parsed = enquirySchema.safeParse(body);
    if (!parsed.success) {
      setErrors(errorsOf(parsed.error));
      return;
    }
    saving.current = true;
    try {
      const saved = await create.mutateAsync({ body, key });
      notifications.show({ color: 'neem', message: 'Enquiry saved' });
      navigate(`/enquiries/${saved.id}`);
    } catch {
      saving.current = false;
    }
  }

  const serverError = create.error;
  return (
    <Stack gap="lg" pb="xl">
      <PageHeader title="New enquiry" />
      <div>
        <TextInput
          label="Phone"
          type="tel"
          size="lg"
          autoFocus
          autoComplete="off"
          inputMode="tel"
          error={errors.phone}
          value={form.phone}
          onChange={(e) => edit({ phone: e.currentTarget.value })}
        />
        <PhoneCheck check={check.data} />
      </div>
      <TextInput label="Name" size="lg" maxLength={100} error={errors.name} value={form.name} onChange={(e) => edit({ name: e.currentTarget.value })} />
      <InterestChips
        garmentTypes={garmentTypes}
        value={form.garmentTypes}
        onChange={(garmentTypes) => edit({ garmentTypes })}
        details={form.interest}
        onDetails={(interest) => edit({ interest })}
      />
      <TextInput
        label="Budget (rough)"
        size="md"
        inputMode="decimal"
        leftSection="₹"
        placeholder="Optional"
        error={errors.budget}
        value={form.budget}
        onChange={(e) => edit({ budget: e.currentTarget.value.replace(/[^0-9.,]/g, '') })}
      />
      <div role="group" aria-label="How did they hear of us?">
        <Text size="md" fw={500} mb={6}>
          How did they hear of us?
        </Text>
        <Chip.Group multiple={false} value={form.source} onChange={(source) => edit({ source })}>
          <Group gap="xs">
            {SOURCES.map((s) => (
              <Chip key={s.value} value={s.value} type="radio" size="md" variant="outline">
                {s.label}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </div>
      <FollowUpChips today={today} value={form.followUpDate} onChange={(followUpDate) => edit({ followUpDate })} />
      <TextInput label="Occasion date (optional)" type="date" size="md" min={today} value={form.occasionDate} onChange={(e) => edit({ occasionDate: e.currentTarget.value })} />
      <TextInput label="Note (optional)" size="md" maxLength={500} value={form.note} onChange={(e) => edit({ note: e.currentTarget.value })} />

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
        {Object.keys(errors).length > 0 && (
          <Alert color="red" role="alert">
            {Object.values(errors).map((m) => (
              <div key={m}>{m}</div>
            ))}
          </Alert>
        )}
        {serverError && (
          <Alert color="red">
            {SAVE_ERRORS[serverError.code] ?? serverError.message}
            {serverError.code === 'ENQUIRY_EXISTS' && serverError.details?.enquiryId && (
              <Button ml="sm" size="compact-sm" variant="light" onClick={() => navigate(`/enquiries/${serverError.details.enquiryId}`)}>
                Open it
              </Button>
            )}
          </Alert>
        )}
        <Button size="xl" fullWidth loading={create.isPending} disabled={!ready} onClick={save}>
          Save enquiry
        </Button>
      </Stack>
    </Stack>
  );
}

/** "New enquiry" (/enquiries/new): a phone call taken down in about 15 seconds. */
export function NewEnquiryPage() {
  const location = useLocation();
  const settings = useSettings();
  if (settings.isPending) return <Loader />;
  if (settings.error) return <Alert color="red">{settings.error.message}</Alert>;
  return <EnquiryForm key={location.key} garmentTypes={settings.data.garmentTypes} />;
}
