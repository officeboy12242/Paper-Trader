import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';

const data = new Uint8Array(fs.readFileSync(process.argv[2]));
const doc = await getDocument({ data, useSystemFonts: true }).promise;
let out = '';
for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out += `\n===== PAGE ${i} =====\n` + content.items.map((it) => it.str).join(' ') + '\n';
}
console.log(out);
