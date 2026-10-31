import { useRef } from 'react';
import { ActionIcon, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconCamera, IconFile, IconPhoto, IconX } from '@tabler/icons-react';
import { MAX_EXPENSE_ATTACHMENTS } from '@vs/shared/expenses.js';
import { shrinkImage } from '../../lib/shrinkImage.js';
import { uploadFile } from '../../lib/upload.js';
import { useFileUrl } from '../settings/settingsApi.js';

const ACCEPT = 'image/*,application/pdf';
const isPdf = (name) => /\.pdf$/i.test(name);

function Thumb({ photo }) {
  const url = useFileUrl(photo.status === 'done' && !isPdf(photo.name) ? photo.key : null);
  if (url.data?.url) return <img src={url.data.url} alt="" width={56} height={56} style={{ objectFit: 'cover', borderRadius: 6 }} />;
  return photo.status === 'uploading' ? <Loader size="sm" /> : isPdf(photo.name) ? <IconFile size={32} aria-hidden /> : <IconPhoto size={32} aria-hidden />;
}

/**
 * "Photo of the bill": a camera button and a file button. Each photo is made smaller and uploaded
 * at once, while staff fill in the rest. `photos` are { id, key, name, status: 'uploading' | 'done' | 'failed' };
 * `setPhotos(update)` takes a function from the old list to the new one.
 */
export function BillPhotos({ photos, setPhotos }) {
  const camera = useRef(null);
  const chooser = useRef(null);
  const full = photos.length >= MAX_EXPENSE_ATTACHMENTS;

  async function add(files) {
    for (const original of files) {
      const id = crypto.randomUUID();
      const patch = (fields) => setPhotos((list) => list.map((p) => (p.id === id ? { ...p, ...fields } : p)));
      // The limit is applied to the latest list, so quick picks cannot pass it (an extra one is dropped).
      setPhotos((list) => (list.length < MAX_EXPENSE_ATTACHMENTS ? [...list, { id, key: null, name: original.name, status: 'uploading' }] : list));
      try {
        const file = await shrinkImage(original);
        const key = await uploadFile(file, 'expense_bill');
        patch({ key, name: file.name, status: 'done' });
      } catch {
        patch({ status: 'failed' });
      }
    }
  }

  const onPick = (e) => {
    const files = [...e.currentTarget.files];
    e.currentTarget.value = '';
    add(files);
  };

  return (
    <div role="group" aria-label="Photo of the bill">
      <Text size="md" fw={500} mb={6}>
        Photo of the bill
      </Text>
      <Group grow gap="sm">
        <Button size="lg" variant="default" leftSection={<IconCamera size={20} />} disabled={full} onClick={() => camera.current?.click()}>
          Take photo
        </Button>
        <Button size="lg" variant="default" leftSection={<IconPhoto size={20} />} disabled={full} onClick={() => chooser.current?.click()}>
          Choose file
        </Button>
      </Group>
      <input ref={camera} type="file" accept={ACCEPT} capture="environment" aria-label="Bill photo from camera" onChange={onPick} style={{ display: 'none' }} />
      <input ref={chooser} type="file" accept={ACCEPT} multiple aria-label="Bill file" onChange={onPick} style={{ display: 'none' }} />
      {photos.length > 0 && (
        <Stack gap="xs" mt="sm">
          {photos.map((photo) => (
            <Paper key={photo.id} withBorder p="xs" radius="md">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Thumb photo={photo} />
                  <Stack gap={0} style={{ minWidth: 0 }}>
                    <Text size="sm" truncate>
                      {photo.name}
                    </Text>
                    {photo.status === 'uploading' && (
                      <Text size="xs" c="dimmed">
                        Uploading…
                      </Text>
                    )}
                    {photo.status === 'failed' && (
                      <Text size="xs" c="red">
                        This did not upload. Remove it and add it again.
                      </Text>
                    )}
                  </Stack>
                </Group>
                <ActionIcon variant="subtle" size={44} color="gray" aria-label={`Remove ${photo.name}`} onClick={() => setPhotos((list) => list.filter((p) => p.id !== photo.id))}>
                  <IconX size={20} />
                </ActionIcon>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
      {full && (
        <Text size="sm" c="dimmed" mt={4}>
          You can add up to {MAX_EXPENSE_ATTACHMENTS} photos.
        </Text>
      )}
    </div>
  );
}
