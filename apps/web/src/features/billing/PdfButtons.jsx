import { useEffect, useRef, useState } from 'react';
import { Button, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPrinter, IconShare } from '@tabler/icons-react';
import { sharePdf } from '../../lib/share.js';
import { openInNewTab } from '../../lib/upload.js';
import { usePdfLink } from './billingApi.js';

/** How long to keep checking for a PDF before saying it is taking longer than usual. */
export const PDF_PATIENCE_MS = 2 * 60_000;

const NOT_READY = 'The PDF is not ready yet. Try again in a minute.';
const SLOW = 'The PDF is taking longer than usual. Try again in a minute.';
const PRINT_FAILED = 'Couldn’t open the PDF. Check your connection and try again.';
const SHARE_FAILED = 'Couldn’t share. Use Print / PDF to download it instead.';

class PdfNotReady extends Error {}

/**
 * "Print / PDF" and "Share" for an issued document. The PDF is made a moment after issue:
 * until then the button says "Preparing the PDF…" and the link is re-checked every 5 seconds,
 * for two minutes at most; after that the person is told and can try again. Each tap asks for
 * a fresh signed link (they last 5 minutes).
 */
export function PdfButtons({ docId, number, kind = 'Bill' }) {
  const [slow, setSlow] = useState(false);
  const link = usePdfLink(docId, { poll: !slow });
  const [sharing, setSharing] = useState(false);
  const fetched = useRef(null); // a PDF fetched for a share the browser refused to start
  const pending = link.data?.status === 'pending';
  // A failed link request leaves the buttons usable: each tap asks again.
  const usable = link.data?.status === 'ready' || link.isError;

  useEffect(() => {
    if (!pending || slow) return undefined;
    const timer = setTimeout(() => setSlow(true), PDF_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [pending, slow]);

  const freshLink = async () => {
    const { data, error } = await link.refetch();
    if (error) throw error;
    if (data?.status !== 'ready' || !data.url) throw new PdfNotReady();
    return data;
  };
  const tell = (message) => notifications.show({ color: 'red', message });

  const print = () => openInNewTab(async () => (await freshLink()).url).catch((e) => tell(e instanceof PdfNotReady ? NOT_READY : PRINT_FAILED));

  async function share() {
    setSharing(true);
    try {
      const file = fetched.current;
      fetched.current = null;
      const data = file ? { filename: file.name } : await freshLink();
      const result = await sharePdf({ url: data.url, filename: data.filename, title: `${kind} ${number}`, file });
      if (result === 'downloaded') notifications.show({ color: 'neem', message: 'The PDF is saved in your downloads.' });
    } catch (error) {
      if (error?.name === 'NotAllowedError' && error.file) {
        fetched.current = error.file;
        notifications.show({ color: 'indigo', message: 'The PDF is ready. Tap Share again to send it.' });
      } else {
        tell(error instanceof PdfNotReady ? NOT_READY : SHARE_FAILED);
      }
    } finally {
      setSharing(false);
    }
  }

  function tryAgain() {
    setSlow(false);
    link.refetch();
  }

  return (
    <Stack gap="xs">
      <Group gap="sm" grow preventGrowOverflow={false} style={{ maxWidth: 420 }}>
        <Button size="md" leftSection={<IconPrinter size={18} />} disabled={!usable} onClick={print}>
          {usable ? 'Print / PDF' : 'Preparing the PDF…'}
        </Button>
        <Button size="md" variant="default" leftSection={<IconShare size={18} />} disabled={!usable} loading={sharing} onClick={share}>
          Share
        </Button>
      </Group>
      {slow && pending && (
        <Group gap="sm">
          <Text size="sm">{SLOW}</Text>
          <Button size="sm" variant="light" onClick={tryAgain}>
            Try again
          </Button>
        </Group>
      )}
    </Stack>
  );
}
