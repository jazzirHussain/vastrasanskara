import { useRef, useState } from 'react';
import { Button, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPrinter, IconShare } from '@tabler/icons-react';
import { sharePdf } from '../../lib/share.js';
import { openInNewTab } from '../../lib/upload.js';
import { usePdfLink } from './billingApi.js';

/**
 * "Print / PDF" and "Share" for an issued document. The PDF is made a moment after issue:
 * until then the button says "Preparing the PDF…" and the link is re-checked every 5 seconds.
 * Each tap asks for a fresh signed link (they last 5 minutes).
 */
export function PdfButtons({ docId, number, kind = 'Bill' }) {
  const link = usePdfLink(docId, { poll: true });
  const [sharing, setSharing] = useState(false);
  const fetched = useRef(null); // a PDF fetched for a share the browser refused to start
  const ready = link.data?.status === 'ready';

  const freshLink = async () => {
    const { data } = await link.refetch({ throwOnError: true });
    if (data?.status !== 'ready' || !data.url) throw new Error('The PDF is not ready yet. Try again in a minute.');
    return data;
  };
  const failed = (error) => notifications.show({ color: 'red', message: error.message || 'Could not open the PDF. Please try again.' });

  const print = () => openInNewTab(async () => (await freshLink()).url).catch(failed);

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
        failed(error);
      }
    } finally {
      setSharing(false);
    }
  }

  return (
    <Group gap="sm" grow preventGrowOverflow={false} style={{ maxWidth: 420 }}>
      <Button size="md" leftSection={<IconPrinter size={18} />} disabled={!ready} onClick={print}>
        {ready || link.isError ? 'Print / PDF' : 'Preparing the PDF…'}
      </Button>
      <Button size="md" variant="default" leftSection={<IconShare size={18} />} disabled={!ready} loading={sharing} onClick={share}>
        Share
      </Button>
    </Group>
  );
}
