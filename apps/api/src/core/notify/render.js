const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Replaces {name} placeholders with vars[name]. A missing (null/undefined) variable throws,
 * so a message is never sent with a blank where data should be. `escape` is applied to values.
 */
export function renderTemplate(text, vars, { escape } = {}) {
  return text.replace(/\{(\w+)\}/g, (_, name) => {
    const value = vars[name];
    if (value === undefined || value === null) throw new Error(`Missing template variable: ${name}`);
    return escape ? escape(String(value)) : String(value);
  });
}
