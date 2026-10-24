export const ALLOWED_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
});
export const MAX_UPLOAD_BYTES = 10485760;

const purposes = new Map();

/**
 * Declares what a file is for and who may upload or read it. Branch scoping is enforced
 * by the files service (keys start with the branch id); canRead adds purpose-specific checks.
 */
export function registerFilePurpose(
  name,
  { allowedTypes = Object.keys(ALLOWED_TYPES), canWrite, canRead },
) {
  purposes.set(name, { allowedTypes, canWrite, canRead });
}

export function getFilePurpose(name) {
  return purposes.get(name) ?? null;
}

// Registered centrally so every process (API and worker) knows every purpose.
registerFilePurpose('branch_logo', {
  canWrite: (user) => user.permissions.has('settings.edit'),
  canRead: async () => true,
});
