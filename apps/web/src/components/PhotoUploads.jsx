import { useState } from 'react';
import { Alert, CloseButton, Group, Text } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconPhotoPlus } from '@tabler/icons-react';
import { uploadFile } from '../lib/upload.js';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAX_FILES = 10;

/**
 * Photo uploads for a file purpose. `value` holds stored keys or `{ key, name }` for new ones;
 * `onChange` gets the new list (at most 10).
 */
export function PhotoUploads({ value, onChange, purpose, label, accept = IMAGE_TYPES }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  async function drop(files) {
    setError(null);
    setUploading(true);
    try {
      const added = [];
      for (const file of files) added.push({ key: await uploadFile(file, purpose), name: file.name });
      onChange([...value, ...added].slice(0, MAX_FILES));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <Dropzone onDrop={drop} accept={accept} maxSize={10 * 1024 * 1024} loading={uploading} p="sm" radius="sm">
        <Group gap="xs" justify="center" style={{ pointerEvents: 'none' }}>
          <IconPhotoPlus size={20} stroke={1.6} color="var(--vs-muted)" aria-hidden="true" />
          <Text size="sm" c="var(--vs-muted)">
            {label}
          </Text>
        </Group>
      </Dropzone>
      {error && (
        <Alert color="red" mt="xs">
          {error}
        </Alert>
      )}
      {value.length > 0 && (
        <Group gap={6} mt={6}>
          {value.map((r, i) => (
            <Group key={r.key ?? r} gap={2} className="vs-panel" px={8} py={2}>
              <Text size="xs">{r.name ?? `Photo ${i + 1}`}</Text>
              <CloseButton
                size="xs"
                aria-label={`Remove ${r.name ?? `photo ${i + 1}`}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              />
            </Group>
          ))}
        </Group>
      )}
    </div>
  );
}
