/**
 * Extract plain text from resume uploads: PDF, DOC, DOCX, TXT.
 */

import zlib from 'zlib';
import { normalizeResumeExtract } from './resumeStructure.js';
import { extractPdfColorPalette } from './resumePdfColors.js';
import { extractPdfTypography } from './resumePdfFonts.js';

const MAX_CHARS = 80_000;
const MIN_CHARS = 40;

const EXT_BY_MIME = {
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-word': 'doc',
};

/**
 * @param {string} [fileName]
 * @param {string} [mimetype]
 * @returns {'pdf'|'doc'|'docx'|'txt'|null}
 */
export function detectResumeKind(fileName = '', mimetype = '') {
    const mime = String(mimetype || '').toLowerCase().split(';')[0].trim();
    if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];

    const name = String(fileName || '').toLowerCase();
    const m = name.match(/\.([a-z0-9]+)$/);
    const ext = m?.[1];
    if (ext === 'pdf' || ext === 'doc' || ext === 'docx' || ext === 'txt' || ext === 'text') {
        return ext === 'text' ? 'txt' : ext;
    }
    if (mime.startsWith('text/')) return 'txt';
    return null;
}

/**
 * Strip multipart/form-data or other wrappers so the real file starts at offset 0.
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function unwrapResumeBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 5) return buffer;

    if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return buffer;
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return buffer; // ZIP / DOCX
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf) return buffer; // OLE / DOC

    const pdfAt = buffer.indexOf(Buffer.from('%PDF-'));
    if (pdfAt > 0 && pdfAt < 8192) return buffer.subarray(pdfAt);

    const pkAt = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (pkAt > 0 && pkAt < 8192) return buffer.subarray(pkAt);

    const oleAt = buffer.indexOf(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    if (oleAt > 0 && oleAt < 8192) return buffer.subarray(oleAt);

    return buffer;
}

/**
 * Kind from file magic (WhatsApp often sends application/octet-stream with no extension).
 * @param {Buffer} buffer
 * @returns {'pdf'|'doc'|'docx'|'txt'|null}
 */
export function sniffResumeKind(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 5) return null;
    const b = unwrapResumeBuffer(buffer);

    if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
        // DOCX is a ZIP; reject images/other zips by looking for word/
        const ascii = b.subarray(0, Math.min(b.length, 40_000)).toString('latin1');
        if (ascii.includes('word/') || ascii.includes('word\\')) return 'docx';
        return 'docx'; // ponytail: resume uploads as ZIP are almost always DOCX
    }
    if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'doc';

    // Mostly printable → treat as TXT (skip obvious binary)
    const sample = b.subarray(0, Math.min(b.length, 2048));
    let printable = 0;
    for (let i = 0; i < sample.length; i++) {
        const c = sample[i];
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 160) printable += 1;
    }
    if (sample.length >= 40 && printable / sample.length >= 0.92) return 'txt';
    return null;
}

function cleanText(raw) {
    return String(raw || '')
        .replace(/\u0000/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, MAX_CHARS);
}

function decodePdfLiteral(raw) {
    return String(raw || '').replace(/\\([nrtbf()\\])/g, (_, c) => {
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        return map[c] || c;
    });
}

function decodeAscii85(input) {
    const src = String(input || '').replace(/\s+/g, '');
    const out = [];
    let i = 0;
    if (src.startsWith('<~')) i = 2;
    const eod = src.indexOf('~>', i);
    const end = eod >= 0 ? eod : src.length;
    while (i < end) {
        if (src[i] === 'z') {
            out.push(0, 0, 0, 0);
            i += 1;
            continue;
        }
        const n = Math.min(5, end - i);
        if (n < 2) break;
        let chunk = src.slice(i, i + n);
        if (n < 5) chunk += 'u'.repeat(5 - n);
        let value = 0;
        for (let j = 0; j < 5; j++) {
            const c = chunk.charCodeAt(j) - 33;
            if (c < 0 || c > 84) return null;
            value = value * 85 + c;
        }
        const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
        const useful = n < 5 ? n - 1 : 4;
        for (let j = 0; j < useful; j++) out.push(bytes[j]);
        i += n;
    }
    return Buffer.from(out);
}

/** Salvage text from content streams when pdf-parse returns little / fails (Flate / ASCII85). */
function extractPdfTextFromStreams(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 100) return '';
    const parts = [];

    for (let i = 0; i < buffer.length - 6; i++) {
        if (buffer.toString('ascii', i, i + 6) !== 'stream') continue;
        // Avoid matching the trailing "stream" inside "endstream"
        if (i >= 3 && buffer.toString('ascii', i - 3, i) === 'end') continue;
        const prev = i > 0 ? buffer[i - 1] : 0;
        // Real stream keyword is preceded by whitespace / > / newline
        if (prev && prev !== 0x0a && prev !== 0x0d && prev !== 0x20 && prev !== 0x3e) continue;

        let start = i + 6;
        if (buffer[start] === 0x0d) start += 1;
        if (buffer[start] === 0x0a) start += 1;
        let end = -1;
        for (let j = start; j < Math.min(buffer.length - 9, start + 800_000); j++) {
            if (buffer.toString('ascii', j, j + 9) === 'endstream') {
                end = j;
                break;
            }
        }
        if (end < 0) continue;

        const header = buffer.toString('latin1', Math.max(0, i - 240), i);
        let payload = buffer.subarray(start, end);
        try {
            if (/ASCII85Decode/i.test(header)) {
                const decoded = decodeAscii85(payload.toString('latin1'));
                if (!decoded?.length) continue;
                payload = decoded;
            }
            if (/FlateDecode/i.test(header) || payload[0] === 0x78) {
                payload = zlib.inflateSync(payload);
            }
        } catch {
            continue;
        }

        const t = payload.toString('latin1');
        for (const m of t.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
            parts.push(decodePdfLiteral(m[0].replace(/\s*Tj$/, '').slice(1, -1)));
        }
        for (const m of t.matchAll(/\[(.*?)\]\s*TJ/gs)) {
            for (const sm of m[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
                parts.push(decodePdfLiteral(sm[0].slice(1, -1)));
            }
        }
    }

    // Join with newlines so section headers stay readable after normalize
    return parts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractPdfText(buffer) {
    let text = '';
    let parseErr = null;
    try {
        const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
        const data = await pdfParse(buffer);
        text = data?.text || '';
    } catch (err) {
        parseErr = err;
    }

    if (cleanText(text).length >= MIN_CHARS) {
        return text;
    }

    const salvaged = extractPdfTextFromStreams(buffer);
    if (cleanText(salvaged).length >= MIN_CHARS) {
        return salvaged;
    }

    if (parseErr) {
        throw new Error(
            `Could not parse PDF (${parseErr.message}). Re-export as text-based PDF or DOCX.`
        );
    }
    return text || salvaged;
}

/**
 * @param {Buffer} buffer
 * @param {{ fileName?: string, mimetype?: string }} meta
 * @returns {Promise<{ text: string, kind: string, palette?: object|null, typography?: object|null }>}
 */
export async function extractResumeText(buffer, meta = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('Empty file');
    }

    const raw = unwrapResumeBuffer(buffer);
    const metaKind = detectResumeKind(meta.fileName, meta.mimetype);
    const sniffed = sniffResumeKind(raw);
    // Prefer magic bytes — WA often sends octet-stream / blank filenames
    const kind = sniffed || metaKind;
    if (!kind) {
        throw new Error('Unsupported file. Send PDF, DOC, DOCX, or TXT.');
    }

    let text = '';
    let palette = null;
    let typography = null;
    if (kind === 'pdf') {
        text = await extractPdfText(raw);
        palette = extractPdfColorPalette(raw);
        typography = extractPdfTypography(raw);
    } else if (kind === 'docx') {
        const { default: mammoth } = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer: raw });
        text = result?.value || '';
    } else if (kind === 'doc') {
        const { default: WordExtractor } = await import('word-extractor');
        const extractor = new WordExtractor();
        const doc = await extractor.extract(raw);
        text = doc?.getBody?.() || '';
    } else {
        text = raw.toString('utf8');
    }

    text = normalizeResumeExtract(cleanText(text));
    if (text.length < MIN_CHARS) {
        throw new Error(
            'Could not read enough text from that file. Try a text-based PDF/DOCX/TXT (scanned/image PDFs need OCR — not supported).'
        );
    }

    return { text, kind, palette, typography };
}
