import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { clock } from '../../clock.js';
import { renderPdf } from '../../core/pdf/render.js';
import { createDownloadUrl } from '../../core/files/service.js';
import { notFound } from '../../core/errors.js';
import { emitToAllBranches } from '../../core/notify/emit.js';
import { logger } from '../../logger.js';
import { BillingDocument } from './model.js';
import { documentDefinition } from './pdfLayouts.js';

const STALE_LOCK_MS = 10 * 60_000;
const BACKOFF_MINUTES = [1, 5, 15, 60]; // then hourly
const ALERT_AT_ATTEMPT = 5;

async function logoOf(storage, key) {
  if (!key) return undefined;
  try {
    const chunks = [];
    for await (const chunk of Readable.from(await storage.getObject(key))) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    // pdfkit embeds only PNG and JPEG; anything else (webp, heic, pdf) is skipped.
    const isPng = data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const isJpeg = data[0] === 0xff && data[1] === 0xd8;
    if (!isPng && !isJpeg) return undefined;
    const mime = isPng ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return undefined; // a missing logo never stops a bill
  }
}

// Takes one document off the queue; another worker running at once cannot take the same one.
const claim = (now) =>
  BillingDocument.findOneAndUpdate(
    {
      $or: [
        { 'pdf.status': 'pending', 'pdf.nextAttemptAt': { $lte: now } },
        { 'pdf.status': 'rendering', 'pdf.lockedAt': { $lt: new Date(now.getTime() - STALE_LOCK_MS) } },
      ],
    },
    { $set: { 'pdf.status': 'rendering', 'pdf.lockedAt': now } },
    { sort: { 'pdf.nextAttemptAt': 1 }, new: true },
  ).lean();

async function fail(doc, err, now) {
  const attempts = (doc.pdf.attempts ?? 0) + 1;
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
  await BillingDocument.updateOne(
    { _id: doc._id, 'pdf.status': 'rendering', 'pdf.lockedAt': doc.pdf.lockedAt },
    {
      $set: {
        'pdf.status': 'pending',
        'pdf.attempts': attempts,
        'pdf.nextAttemptAt': new Date(now.getTime() + minutes * 60_000),
        'pdf.lockedAt': null,
        'pdf.lastError': String(err?.message ?? err).slice(0, 500),
      },
    },
  );
  logger.error({ error: err?.message, code: err?.code, docId: String(doc._id), attempts }, 'billing PDF render failed');
  if (attempts === ALERT_AT_ATTEMPT) {
    await emitToAllBranches('system.job_failed', {
      refId: `pdf:${doc._id}`,
      vars: { job: 'billing-pdfs', error: `A ${doc.type.replace('_', ' ')} PDF could not be made after ${attempts} tries` },
    }).catch((e) => logger.error({ err: e }, 'could not alert about a PDF failure'));
  }
}

/** Renders queued PDFs from their snapshots alone and stores them. Returns { rendered, failed }. */
export async function renderPendingPdfs({ storage, now = clock.now(), limit = 20 }) {
  let rendered = 0;
  let failed = 0;
  for (let i = 0; i < limit; i += 1) {
    const doc = await claim(now);
    if (!doc) break;
    try {
      const logo = await logoOf(storage, doc.snapshot?.seller?.logoKey);
      let body;
      try {
        body = await renderPdf(documentDefinition(doc.snapshot, { logo }));
      } catch (err) {
        if (!logo) throw err;
        body = await renderPdf(documentDefinition(doc.snapshot)); // a logo that will not embed never blocks a bill
      }
      // GST records are kept 8 years; with Object Lock on, not even an admin can change them.
      await storage.putObject({ key: doc.pdf.key, body, contentType: 'application/pdf', retainYears: 8 });
      await BillingDocument.updateOne(
        { _id: doc._id, 'pdf.status': 'rendering', 'pdf.lockedAt': doc.pdf.lockedAt },
        {
          $set: {
            'pdf.status': 'ready',
            'pdf.sha256': createHash('sha256').update(body).digest('hex'),
            'pdf.size': body.length,
            'pdf.renderedAt': clock.now(),
            'pdf.lockedAt': null,
            'pdf.lastError': null,
          },
        },
      );
      rendered += 1;
    } catch (err) {
      failed += 1;
      await fail(doc, err, now);
    }
  }
  return { rendered, failed };
}

/** May this user read the stored PDF `key`? Needs money.view and a billing document of their branch. */
export async function canReadBillingPdf(user, key) {
  if (!user.permissions.has('money.view')) return false;
  return Boolean(await BillingDocument.exists({ branchId: user.branchId, 'pdf.key': key }));
}

/** { status, url, filename }: the url only once the PDF is ready. */
export async function pdfLink(branchId, user, docId, storage) {
  const doc = await BillingDocument.findOne({ _id: docId, branchId }, { number: 1, pdf: 1, status: 1 }).lean().catch(() => null);
  if (!doc || !doc.pdf?.key || doc.pdf.status === 'none') throw notFound();
  const filename = `${(doc.number ?? 'document').replace(/\//g, '-')}.pdf`;
  const status = doc.pdf.status === 'rendering' ? 'pending' : doc.pdf.status;
  if (status !== 'ready') return { status, url: null, filename };
  return { status, url: await createDownloadUrl(storage, user, doc.pdf.key), filename };
}
