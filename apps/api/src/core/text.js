// Matching names the way people type them.

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A regex for a lower-cased `searchName` field that matches `name` whatever its case and spacing
 * ('  Lakshmi   DYERS ' matches 'lakshmi dyers'), or null for a blank name.
 */
export function searchNameMatcher(name) {
  const words = String(name ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return new RegExp(`^\\s*${words.map(escapeRegex).join('\\s+')}\\s*$`);
}

/** The same, for a field that keeps its original case (brand, colour); '' matches only blank. */
export function caseInsensitiveMatcher(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return /^\s*$/;
  return new RegExp(`^\\s*${words.map(escapeRegex).join('\\s+')}\\s*$`, 'i');
}
