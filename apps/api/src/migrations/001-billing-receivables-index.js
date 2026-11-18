// The `receivables` index covered bills only; `receivables_v2` (built by the model) also covers
// opening balances. Dropping the old one is safe to run twice.
export default {
  id: '001-billing-receivables-index',
  async up(db) {
    const indexes = await db.collection('billingDocuments').indexes().catch(() => []);
    if (indexes.some((i) => i.name === 'receivables')) await db.collection('billingDocuments').dropIndex('receivables');
  },
};
