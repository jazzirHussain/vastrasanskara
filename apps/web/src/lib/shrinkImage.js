const SHRINKABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BIG_BYTES = 1.5 * 1024 * 1024;

async function decode(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

/**
 * A phone photo made small enough to upload quickly on mobile data: JPEG/PNG/WebP files larger than
 * `maxSide` pixels or 1.5 MB are redrawn at most `maxSide` on the long side as a JPEG File (same
 * base name, `.jpg`). HEIC, PDF and anything that cannot be decoded come back unchanged.
 */
export async function shrinkImage(file, { maxSide = 2000, quality = 0.8 } = {}) {
  if (!SHRINKABLE.has(file.type)) return file;
  try {
    const picture = await decode(file);
    const { width, height } = picture;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    if (scale === 1 && file.size <= BIG_BYTES) {
      picture.close?.();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
    picture.close?.();
    const blob = await toBlob(canvas, quality);
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], `${file.name.replace(/\.[^.]*$/, '')}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
