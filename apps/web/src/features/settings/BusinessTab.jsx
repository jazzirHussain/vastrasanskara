import { useState } from 'react';
import { Alert, Button, FileInput, Group, Image, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { fieldErrors } from '../../lib/fieldErrors.js';
import { uploadFile } from '../../lib/upload.js';
import { useFileUrl, useSaveBranch } from './settingsApi.js';

const PREFIXES = [
  ['invoice', 'Invoice prefix'],
  ['creditNote', 'Credit note prefix'],
  ['receiptVoucher', 'Receipt voucher prefix'],
  ['receipt', 'Receipt prefix'],
  ['refund', 'Refund prefix'],
  ['expense', 'Expense prefix'],
  ['order', 'Order prefix'],
];

const blankToNull = (value) => (value === '' ? null : value);

/** Branch details (PUT /v1/branch). `draft` lives in SettingsPage so it survives tab switches. */
export function BusinessTab({ draft, setDraft }) {
  const saveBranch = useSaveBranch();
  const logoUrl = useFileUrl(draft.logoKey);
  const [uploadError, setUploadError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const errors = fieldErrors(saveBranch.error);

  // Read the value before setDraft: React clears event.currentTarget once the handler returns.
  const set = (field) => (event) => {
    const { value } = event.currentTarget;
    setDraft((d) => ({ ...d, [field]: value }));
  };
  const setAddress = (field) => (event) => {
    const { value } = event.currentTarget;
    setDraft((d) => ({ ...d, address: { ...d.address, [field]: value } }));
  };
  const setPrefix = (field) => (event) => {
    const { value } = event.currentTarget;
    setDraft((d) => ({ ...d, prefixes: { ...d.prefixes, [field]: value } }));
  };

  async function handleLogo(file) {
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const logoKey = await uploadFile(file, 'branch_logo');
      setDraft((d) => ({ ...d, logoKey }));
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  }

  function handleSave() {
    const { id: _id, ...branch } = draft;
    saveBranch.mutate({
      ...branch,
      gstin: blankToNull(branch.gstin ?? ''),
      phone: blankToNull(branch.phone ?? ''),
      email: blankToNull(branch.email ?? ''),
    });
  }

  return (
    <Stack>
      {saveBranch.error && <Alert color="red">{saveBranch.error.message}</Alert>}
      {saveBranch.isSuccess && <Alert color="green">Business details saved.</Alert>}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Business name" value={draft.name} onChange={set('name')} error={errors.name} />
        <TextInput label="Legal name" value={draft.legalName} onChange={set('legalName')} error={errors.legalName} />
        <TextInput
          label="GSTIN"
          value={draft.gstin ?? ''}
          onChange={(e) => {
            const gstin = e.currentTarget.value.toUpperCase();
            setDraft((d) => ({ ...d, gstin }));
          }}
          error={errors.gstin}
        />
        <TextInput
          label="State code"
          description="Two digits; must match the GSTIN"
          value={draft.stateCode}
          onChange={set('stateCode')}
          error={errors.stateCode}
        />
        <TextInput label="Phone" value={draft.phone ?? ''} onChange={set('phone')} error={errors.phone} />
        <TextInput label="Email" value={draft.email ?? ''} onChange={set('email')} error={errors.email} />
      </SimpleGrid>

      <Title order={4}>Address</Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Address line 1" value={draft.address.line1} onChange={setAddress('line1')} />
        <TextInput label="Address line 2" value={draft.address.line2} onChange={setAddress('line2')} />
        <TextInput label="City" value={draft.address.city} onChange={setAddress('city')} />
        <TextInput
          label="PIN code"
          value={draft.address.pincode}
          onChange={setAddress('pincode')}
          error={errors['address.pincode']}
        />
      </SimpleGrid>

      <Title order={4}>Logo</Title>
      <Group align="flex-end">
        {logoUrl.data?.url && <Image src={logoUrl.data.url} alt="Business logo" h={64} w="auto" fit="contain" />}
        <FileInput
          label="Upload logo"
          accept="image/png,image/jpeg,image/webp"
          placeholder="Choose an image"
          onChange={handleLogo}
          disabled={uploading}
          error={uploadError}
        />
      </Group>
      {draft.logoKey && !logoUrl.data && <Text size="sm">New logo uploaded — save to use it.</Text>}

      <Title order={4}>Document number prefixes</Title>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        {PREFIXES.map(([field, label]) => (
          <TextInput
            key={field}
            label={label}
            value={draft.prefixes[field]}
            onChange={setPrefix(field)}
            error={errors[`prefixes.${field}`]}
          />
        ))}
      </SimpleGrid>

      <Group justify="flex-end">
        <Button onClick={handleSave} loading={saveBranch.isPending}>
          Save business details
        </Button>
      </Group>
    </Stack>
  );
}
