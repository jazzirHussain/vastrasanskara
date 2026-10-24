// Development stand-in for S3: files live on disk and presigned URLs point at
// /v1/dev-files/<key> (served by devFilesRoutes.js), signed with HMAC-SHA256.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { clock } from '../../clock.js';
import { AppError, notFound } from '../errors.js';

const linkInvalid = () => new AppError(403, 'FILE_LINK_INVALID', 'This file link is invalid or has expired');

async function readAll(body) {
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of Readable.from(body)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function createLocalStorage({ dir, apiOrigin, secret }) {
  const root = path.resolve(dir);
  const nowSeconds = () => Math.floor(clock.now().getTime() / 1000);
  const sign = (...parts) => createHmac('sha256', secret).update(parts.join('\n')).digest('hex');

  function filePath(key) {
    const resolved = path.resolve(root, key);
    if (!resolved.startsWith(root + path.sep)) throw notFound();
    return resolved;
  }

  function verify(expected, given, exp) {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(given ?? ''));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw linkInvalid();
    if (!(Number(exp) >= nowSeconds())) throw linkInvalid();
  }

  async function readMeta(key) {
    try {
      return JSON.parse(await readFile(`${filePath(key)}.meta.json`, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  const urlFor = (key, params) => `${apiOrigin}/v1/dev-files/${key}?${new URLSearchParams(params)}`;

  return {
    async presignPut({ key, contentType, size }) {
      const exp = nowSeconds() + 300;
      const sig = sign('PUT', key, exp, contentType, size);
      return { url: urlFor(key, { exp, ct: contentType, size, sig }), headers: { 'Content-Type': contentType } };
    },

    async presignGet(key, { expiresIn = 300 } = {}) {
      const exp = nowSeconds() + expiresIn;
      return urlFor(key, { exp, sig: sign('GET', key, exp) });
    },

    /** Checks a presigned upload link; returns the signed content type and size. */
    verifyPutLink({ key, exp, ct, size, sig }) {
      verify(sign('PUT', key, exp, ct, size), sig, exp);
      return { contentType: ct, size: Number(size) };
    },

    /** Checks a presigned download link. */
    verifyGetLink({ key, exp, sig }) {
      verify(sign('GET', key, exp), sig, exp);
    },

    async putObject({ key, body, contentType }) {
      const data = await readAll(body);
      const file = filePath(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, data);
      const sha256 = createHash('sha256').update(data).digest('hex');
      await writeFile(`${file}.meta.json`, JSON.stringify({ contentType, size: data.length, sha256 }));
    },

    async getObject(key) {
      if (!(await readMeta(key))) throw notFound();
      return createReadStream(filePath(key));
    },

    async headObject(key) {
      const meta = await readMeta(key);
      if (!meta) return null;
      return { size: (await stat(filePath(key))).size, sha256: meta.sha256, contentType: meta.contentType };
    },
  };
}
