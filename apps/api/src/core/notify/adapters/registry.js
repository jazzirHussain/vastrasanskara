/**
 * Channel adapters: { channel, provider, capabilities: { attachments, templatesOnly, maxLength? },
 * send(message) → { providerMessageId, status: 'sent'|'delivered' }, parseWebhook?(req) }.
 * message = { to, subject?, text, html?, attachments: [{ filename, content }], event, vars, branchId }.
 */
const byChannel = new Map();
const byProvider = new Map();

export function registerAdapter(adapter) {
  byChannel.set(adapter.channel, adapter);
  byProvider.set(adapter.provider, adapter);
}

export function getAdapter(channel) {
  return byChannel.get(channel) ?? null;
}

export function getAdapterByProvider(provider) {
  return byProvider.get(provider) ?? null;
}

export function resetAdapters() {
  byChannel.clear();
  byProvider.clear();
}
