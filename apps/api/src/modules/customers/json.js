// Customer response shape.

export function toCustomerJson(c) {
  return {
    id: String(c._id),
    name: c.name,
    phone: c.phone,
    email: c.email ?? null,
    type: c.type,
    gstin: c.gstin ?? null,
    stateCode: c.stateCode,
    billingAddress: { line1: '', line2: '', city: '', pincode: '', ...c.billingAddress },
    source: c.source,
    consent: { email: false, whatsapp: false, sms: false, ...c.consent },
    consentNote: c.consentNote ?? '',
    preferredChannel: c.preferredChannel ?? null,
    createdAt: c.createdAt,
    version: c.__v,
  };
}
