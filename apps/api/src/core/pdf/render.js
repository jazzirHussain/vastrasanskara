import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PdfPrinter from 'pdfmake';

const fontDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');
const regular = path.join(fontDir, 'NotoSans-Regular.ttf');
const bold = path.join(fontDir, 'NotoSans-Bold.ttf');
export const FONT_FILES = Object.freeze({ regular, bold });

// Noto Sans (SIL OFL) has the rupee sign; the standard PDF fonts do not.
const printer = new PdfPrinter({
  NotoSans: { normal: regular, bold, italics: regular, bolditalics: bold },
});

/** Renders a pdfmake document definition to a PDF Buffer (A4, Noto Sans). */
export function renderPdf(docDefinition) {
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument({
      pageSize: 'A4',
      pageMargins: [36, 36, 36, 40],
      ...docDefinition,
      defaultStyle: { font: 'NotoSans', fontSize: 9, ...docDefinition.defaultStyle },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
