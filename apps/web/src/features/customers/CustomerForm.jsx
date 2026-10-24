import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Anchor, Button, Checkbox, Group, Select, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { customerSchema } from '@vs/shared/schemas/customers.js';
import { fieldErrors } from '../../lib/fieldErrors.js';

export const CUSTOMER_TYPES = [
  { value: 'individual', label: 'Individual' },
  { value: 'business', label: 'Business' },
  { value: 'film_production', label: 'Film production' },
];
export const SOURCES = [
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'referral', label: 'Referral' },
  { value: 'website', label: 'Website' },
  { value: 'film_industry', label: 'Film industry' },
  { value: 'other', label: 'Other' },
];
const CHANNELS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
];

const EDITABLE = ['name', 'phone', 'email', 'type', 'gstin', 'billingAddress', 'source', 'consent', 'consentNote', 'preferredChannel'];

const BLANK = {
  name: '',
  phone: '',
  email: '',
  type: 'individual',
  gstin: '',
  billingAddress: { line1: '', line2: '', city: '', pincode: '' },
  source: 'walk_in',
  consent: { email: false, whatsapp: false, sms: false },
  consentNote: '',
  preferredChannel: null,
};

// The form keeps blanks as ''; the API wants null for "none".
function toInput(draft) {
  return { ...draft, email: draft.email.trim() || null, gstin: draft.gstin.trim().toUpperCase() || null };
}

function fromCustomer(c) {
  return {
    ...BLANK,
    ...c,
    email: c.email ?? '',
    gstin: c.gstin ?? '',
  };
}

const zodErrors = (error) => Object.fromEntries(error.issues.map((i) => [i.path.join('.'), i.message]));

/**
 * Add or edit a customer. Checks the shared rules before sending (consent needs a note, a GSTIN
 * fixes the state); edits send only the changed fields. A phone already on file links to them,
 * or offers them through `onUseExisting(customerId)` when the form is part of another flow.
 */
export function CustomerForm({ customer, mutation, onSaved, onUseExisting }) {
  const editing = Boolean(customer);
  const original = editing ? fromCustomer(customer) : BLANK;
  const [draft, setDraft] = useState(original);
  const [localErrors, setLocalErrors] = useState({});
  const errors = { ...fieldErrors(mutation.error), ...localErrors };
  const set = (key, value) => {
    setLocalErrors({});
    mutation.reset();
    setDraft((d) => ({ ...d, [key]: value }));
  };

  function submit(event) {
    event.preventDefault();
    const input = toInput(draft);
    let body;
    if (editing) {
      const base = toInput(original);
      body = Object.fromEntries(
        EDITABLE.filter((k) => JSON.stringify(input[k]) !== JSON.stringify(base[k])).map((k) => [k, input[k]]),
      );
      if (Object.keys(body).length === 0) return onSaved(customer);
      const check = customerSchema.safeParse({ ...input, stateCode: customer.stateCode });
      if (!check.success) return setLocalErrors(zodErrors(check.error));
      return mutation.mutate({ version: customer.version, changes: body }, { onSuccess: onSaved });
    }
    const check = customerSchema.safeParse(input);
    if (!check.success) return setLocalErrors(zodErrors(check.error));
    return mutation.mutate(input, { onSuccess: onSaved });
  }

  const anyConsent = draft.consent.email || draft.consent.whatsapp || draft.consent.sms;
  const duplicate = mutation.error?.code === 'PHONE_TAKEN' ? mutation.error.details?.customerId : null;

  return (
    <form onSubmit={submit}>
      <Stack>
        {duplicate && (
          <Alert color="yellow">
            A customer with this phone already exists.{' '}
            {onUseExisting ? (
              <Anchor component="button" type="button" onClick={() => onUseExisting(duplicate)}>
                Use this customer
              </Anchor>
            ) : (
              <Anchor component={Link} to={`/customers/${duplicate}`}>
                Open their page
              </Anchor>
            )}
          </Alert>
        )}
        {mutation.error && !duplicate && mutation.error.code !== 'VALIDATION_FAILED' && (
          <Alert color="red">{mutation.error.message}</Alert>
        )}
        <TextInput label="Name" required withAsterisk={false} value={draft.name} onChange={(e) => set('name', e.currentTarget.value)} error={errors.name} />
        <SimpleGrid cols={{ base: 1, xs: 2 }}>
          <TextInput label="Phone" type="tel" required withAsterisk={false} value={draft.phone} onChange={(e) => set('phone', e.currentTarget.value)} error={errors.phone} />
          <TextInput label="Email" type="email" value={draft.email} onChange={(e) => set('email', e.currentTarget.value)} error={errors.email} />
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, xs: 2 }}>
          <Select label="Type" data={CUSTOMER_TYPES} allowDeselect={false} value={draft.type} onChange={(v) => set('type', v)} />
          <Select label="How they found us" data={SOURCES} allowDeselect={false} value={draft.source} onChange={(v) => set('source', v)} />
        </SimpleGrid>
        {draft.type !== 'individual' && (
          <TextInput label="GSTIN" value={draft.gstin} onChange={(e) => set('gstin', e.currentTarget.value)} error={errors.gstin ?? errors.stateCode} />
        )}
        <TextInput
          label="Billing address"
          placeholder="Street and number"
          value={draft.billingAddress.line1}
          onChange={(e) => set('billingAddress', { ...draft.billingAddress, line1: e.currentTarget.value })}
        />
        <SimpleGrid cols={{ base: 2 }}>
          <TextInput label="City" value={draft.billingAddress.city} onChange={(e) => set('billingAddress', { ...draft.billingAddress, city: e.currentTarget.value })} />
          <TextInput
            label="PIN code"
            inputMode="numeric"
            value={draft.billingAddress.pincode}
            onChange={(e) => set('billingAddress', { ...draft.billingAddress, pincode: e.currentTarget.value })}
            error={errors['billingAddress.pincode']}
          />
        </SimpleGrid>

        <div>
          <Text fw={600} size="sm">
            Messages the customer agreed to
          </Text>
          <Group mt={6}>
            {CHANNELS.map((c) => (
              <Checkbox
                key={c.value}
                label={c.label}
                checked={draft.consent[c.value]}
                onChange={(e) => set('consent', { ...draft.consent, [c.value]: e.currentTarget.checked })}
              />
            ))}
          </Group>
        </div>
        {anyConsent && (
          <>
            <Textarea
              label="How they agreed"
              placeholder="e.g. Said yes at the counter on 24 Oct"
              autosize
              minRows={2}
              value={draft.consentNote}
              onChange={(e) => set('consentNote', e.currentTarget.value)}
              error={errors.consentNote}
            />
            <Select
              label="Preferred channel"
              data={CHANNELS.filter((c) => draft.consent[c.value])}
              clearable
              value={draft.preferredChannel}
              onChange={(v) => set('preferredChannel', v)}
            />
          </>
        )}
        {!anyConsent && errors.consentNote && <Text c="red" size="sm">{errors.consentNote}</Text>}
        <Group justify="flex-end">
          <Button type="submit" loading={mutation.isPending}>
            Save customer
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
