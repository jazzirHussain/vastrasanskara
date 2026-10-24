/** { 'billDueDays': 'Too big', ... } from a VALIDATION_FAILED ApiError; {} for anything else. */
export function fieldErrors(error) {
  if (error?.code !== 'VALIDATION_FAILED') return {};
  return Object.fromEntries((error.details ?? []).map((d) => [d.path, d.message]));
}
