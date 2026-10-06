/**
 * Detect primary fonts + header alignment from an uploaded resume PDF.
 */

import fs from 'fs';
import zlib from 'zlib';

const FAMILY_PATHS = {
    Arial: {
        regular: [
            'C:/Windows/Fonts/arial.ttf',
            '/usr/share/fonts/truetype/msttcorefonts/Arial.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        ],
        bold: [
            'C:/Windows/Fonts/arialbd.ttf',
            '/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        ],
    },
    Calibri: {
        regular: [
            'C:/Windows/Fonts/calibri.ttf',
            '/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        ],
        bold: [
            'C:/Windows/Fonts/calibrib.ttf',
            '/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        ],
    },
    Times: {
        regular: [
            'C:/Windows/Fonts/times.ttf',
            'C:/Windows/Fonts/timesnr.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
        ],
        bold: [
            'C:/Windows/Fonts/timesbd.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
        ],
    },
    Georgia: {
        regular: ['C:/Windows/Fonts/georgia.ttf', '/usr/share/fonts/truetype/msttcorefonts/Georgia.ttf'],
        bold: ['C:/Windows/Fonts/georgiab.ttf', '/usr/share/fonts/truetype/msttcorefonts/Georgia_Bold.ttf'],
    },
    Cambria: {
        regular: ['C:/Windows/Fonts/cambria.ttc', 'C:/Windows/Fonts/cambria.ttf'],
        bold: ['C:/Windows/Fonts/cambriab.ttf'],
    },
    Helvetica: {
        regular: [
            '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
            '/System/Library/Fonts/Helvetica.ttc',
        ],
        bold: [
            '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
            '/System/Library/Fonts/Helvetica.ttc',
        ],
    },
};

function firstExisting(paths) {
    for (const p of paths || []) {
        try {
            if (p && fs.existsSync(p)) return p;
        } catch {
            /* ignore */
        }
    }
    return null;
}

function normalizeFamily(baseFont) {
    const raw = String(baseFont || '')
        .replace(/^[A-Z0-9]{6}\+/, '')
        .replace(/MT$/i, '')
        .replace(/PS$/i, '');
    const lower = raw.toLowerCase();
    if (/symbol|wingding|zapf|emoji/i.test(lower)) return null;
    if (/arial|helvetica|liberation.?sans|dejavu.?sans|carlito/i.test(lower)) {
        if (/calibri|carlito/i.test(lower)) return 'Calibri';
        if (/helvetica/i.test(lower)) return 'Helvetica';
        return 'Arial';
    }
    if (/calibri|carlito/i.test(lower)) return 'Calibri';
    if (/times|liberation.?serif|georgia|cambria|garamond|palatino/i.test(lower)) {
        if (/georgia/i.test(lower)) return 'Georgia';
        if (/cambria/i.test(lower)) return 'Cambria';
        return 'Times';
    }
    if (/helvetica/i.test(lower)) return 'Helvetica';
    return null;
}

function inflateStreams(buffer) {
    const out = [];
    for (let i = 0; i < buffer.length - 6; i++) {
        if (buffer.toString('ascii', i, i + 6) !== 'stream') continue;
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
        try {
            out.push(zlib.inflateSync(buffer.subarray(start, end)).toString('latin1'));
        } catch {
            /* not flate */
        }
    }
    return out;
}

/**
 * @param {Buffer} buffer
 * @returns {{ family: string, headerAlign: 'left'|'center' }|null}
 */
export function extractPdfTypography(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 100) return null;

    const ascii = buffer.toString('latin1');
    const counts = new Map();
    for (const m of ascii.matchAll(/\/BaseFont\s*\/([^\s\/\]>]+)/g)) {
        const family = normalizeFamily(m[1]);
        if (!family) continue;
        counts.set(family, (counts.get(family) || 0) + 1);
    }
    for (const m of ascii.matchAll(/\/FontName\s*\/([^\s\/\]>]+)/g)) {
        const family = normalizeFamily(m[1]);
        if (!family) continue;
        counts.set(family, (counts.get(family) || 0) + 1);
    }

    let family = 'Arial';
    if (counts.size) {
        family = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }

    let headerAlign = 'center';
    const streams = inflateStreams(buffer);
    const content = streams.find((t) => /\d+(?:\.\d+)?\s+Tf/.test(t) && /Tm/.test(t)) || '';
    // First large text run (~name): centered if x is well into the page
    const firstBig = content.match(
        /\/F\d+\s+(1[4-9](?:\.\d+)?|[2-9]\d(?:\.\d+)?)\s+Tf[\s\S]{0,120}?1 0 0 1 ([\d.]+) ([\d.]+) Tm/
    );
    if (firstBig) {
        const x = Number(firstBig[2]);
        // Letter width 612; left-margin body ~45; center-ish name starts > ~120
        headerAlign = Number.isFinite(x) && x >= 120 ? 'center' : 'left';
    }

    return { family, headerAlign };
}

/**
 * Resolve TTF paths for a detected family. Returns built-in PDFKit names if files missing.
 * @param {string} [family]
 * @returns {{ regular: string, bold: string, embedded: boolean, family: string }}
 */
export function resolveResumeFontPair(family = 'Arial') {
    const key = FAMILY_PATHS[family] ? family : 'Arial';
    const regular = firstExisting(FAMILY_PATHS[key].regular);
    const bold = firstExisting(FAMILY_PATHS[key].bold) || regular;

    if (regular && bold) {
        return { regular, bold, embedded: true, family: key };
    }

    // PDFKit built-ins as last resort
    if (key === 'Times') {
        return { regular: 'Times-Roman', bold: 'Times-Bold', embedded: false, family: key };
    }
    return { regular: 'Helvetica', bold: 'Helvetica-Bold', embedded: false, family: key };
}

/**
 * @param {import('pdfkit')} doc
 * @param {{ regular: string, bold: string, embedded: boolean }} fonts
 * @returns {{ regular: string, bold: string }}
 */
export function registerResumeFonts(doc, fonts) {
    if (!fonts?.embedded) {
        return { regular: fonts?.regular || 'Helvetica', bold: fonts?.bold || 'Helvetica-Bold' };
    }
    const regularName = 'ResumeRegular';
    const boldName = 'ResumeBold';
    try {
        doc.registerFont(regularName, fonts.regular);
        doc.registerFont(boldName, fonts.bold);
        return { regular: regularName, bold: boldName };
    } catch {
        return { regular: 'Helvetica', bold: 'Helvetica-Bold' };
    }
}

export function defaultTypographyForStyle(style) {
    return {
        family: style === 'ats' ? 'Arial' : 'Times',
        headerAlign: 'center',
    };
}
