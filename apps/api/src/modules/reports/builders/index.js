// Report builders by kind. A builder is
//   async (branchId, params, { storage, maxRows }) → { files: [{ sheets } | { pdf }, ...] }
// The first file is the report; any others (the GST pack's second workbook) carry a `filename`.
// `format` is the run's format (a PDF report returns { pdf, sheets }: the sheets give its rows and hash).
const builders = new Map();

export function registerBuilder(kind, build) {
  builders.set(kind, build);
}

export const getBuilder = (kind) => builders.get(kind);

export const PAGE_LIMIT = 100;

/** Every item of a cursor-paged list, 100 a page, refusing more than `maxRows` (REPORT_TOO_LARGE). */
export async function allPages(fetchPage, maxRows, check) {
  const items = [];
  let cursor;
  do {
    const page = await fetchPage({ cursor, limit: PAGE_LIMIT });
    items.push(...page.items);
    check(items.length, maxRows);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
