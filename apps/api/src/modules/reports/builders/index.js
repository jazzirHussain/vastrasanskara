// Report builders by kind. A builder is
//   async (branchId, params, { storage, maxRows }) → { files: [{ sheets } | { pdf }, ...] }
// The first file is the report; any others (the GST pack's second workbook) carry a `filename`.
const builders = new Map();

export function registerBuilder(kind, build) {
  builders.set(kind, build);
}

export const getBuilder = (kind) => builders.get(kind);
