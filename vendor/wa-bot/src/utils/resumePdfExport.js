/**
 * Resume PDF export — ATS/classic layout, detected fonts/colors, hard 1-page fit.
 */

import {
    normalizeResumeExtract,
    extractSectionTitles,
    extractHeaderLines,
    looksLikeSectionHeader,
    detectResumeLayoutProfile,
} from './resumeStructure.js';
import { resolveResumePalette } from './resumePdfColors.js';
import {
    resolveResumeFontPair,
    registerResumeFonts,
    defaultTypographyForStyle,
} from './resumePdfFonts.js';

function isSectionHeader(line, knownTitles = []) {
    return looksLikeSectionHeader(line, knownTitles, {});
}

function isBullet(line) {
    return /^[\u2022\-\*\u2013\u2014•–—]\s*/.test(String(line || '').trim());
}

function isSkillLine(line) {
    return /^[A-Za-z][A-Za-z0-9 /&+]{1,40}:\s+\S/.test(String(line || '').trim());
}

function isYearBand(line) {
    const t = String(line || '').trim();
    if (/^\d{4}$/.test(t)) return true;
    if (/^\d{4}\s*[-–—]\s*(?:Present|\d{4})$/i.test(t)) return true;
    if (
        /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\s*[-–—]\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})$/i.test(
            t
        )
    ) {
        return true;
    }
    return false;
}

function splitTitleDate(line) {
    const t = String(line || '').trim();
    if (!t) return null;

    if (t.includes('\t')) {
        const [left, ...rest] = t.split('\t');
        const dates = rest.join(' ').trim();
        if (left && dates) return { title: left.trim(), dates };
    }

    const m2 = t.match(
        /^(.+?)\s{2,}((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\s*[-–—\(].+)$/i
    );
    if (m2) return { title: m2[1].trim(), dates: m2[2].trim() };

    const m3 = t.match(
        /^(.+?)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\s*[-–—\(].+)$/i
    );
    if (m3 && (m3[1].includes('|') || m3[1].length > 12)) {
        return { title: m3[1].trim(), dates: m3[2].trim() };
    }

    const m4 = t.match(/^(.+?)\s+(\d{4}\s*[–\-—]\s*(?:Present|\d{4}))$/i);
    if (m4 && m4[1].length > 8) return { title: m4[1].trim(), dates: m4[2].trim() };

    return null;
}

function pageContentWidth(doc) {
    return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function drawSectionRule(doc, palette, scale) {
    const x = doc.page.margins.left;
    const y = doc.y + 1 * scale;
    const w = pageContentWidth(doc);
    doc.moveTo(x, y)
        .lineTo(x + w, y)
        .strokeColor(palette.rule)
        .lineWidth(0.85 * scale)
        .stroke();
    doc.moveDown(0.22 * scale);
}

function writeTitleDateLine(doc, title, dates, palette, fonts, scale) {
    const ml = doc.page.margins.left;
    const pw = pageContentWidth(doc);
    const startY = doc.y;
    const bodySize = 10 * scale;

    doc.font(fonts.regular).fontSize(bodySize);
    const dateW = doc.widthOfString(dates);
    const titleMaxW = Math.max(80, pw - dateW - 10 * scale);

    doc.font(fonts.bold).fontSize(10.5 * scale).fillColor(palette.accent);
    doc.text(title, ml, startY, {
        width: titleMaxW,
        align: 'left',
        lineGap: 0.4 * scale,
    });
    const afterTitleY = doc.y;

    doc.font(fonts.regular).fontSize(bodySize).fillColor(palette.muted);
    doc.text(dates, ml + pw - dateW, startY, {
        width: dateW,
        align: 'left',
        lineBreak: false,
    });

    doc.x = ml;
    doc.y = Math.max(afterTitleY, startY + 11 * scale) + 1 * scale;
}

function writeHeader(doc, headerLines, profile, palette, fonts, scale) {
    const align = profile.headerAlign || 'center';
    if (!headerLines.length) return;

    for (let i = 0; i < headerLines.length; i++) {
        const line = headerLines[i];
        if (i === 0) {
            doc.font(fonts.bold)
                .fontSize((profile.style === 'ats' ? 18 : 17) * scale)
                .fillColor(palette.name)
                .text(line, {
                    align,
                    paragraphGap: 1 * scale,
                });
        } else if (i === 1 && profile.style === 'ats' && /\|/.test(line) && !/@/.test(line)) {
            doc.font(fonts.regular)
                .fontSize(9.5 * scale)
                .fillColor(palette.body)
                .text(line, {
                    align,
                    paragraphGap: 1 * scale,
                });
        } else {
            doc.font(fonts.regular)
                .fontSize(9 * scale)
                .fillColor(palette.muted)
                .text(line, {
                    align,
                    paragraphGap: 0.5 * scale,
                });
        }
    }
    doc.moveDown(0.28 * scale);
}

function paintResume(doc, text, opts, scale, fonts) {
    const { knownTitles, baseHeader, profile, palette, bulletChar } = opts;

    const lines = text.split('\n');
    let i = 0;
    const header = baseHeader.length ? baseHeader : extractHeaderLines(text);
    if (header.length) {
        writeHeader(doc, header, profile, palette, fonts, scale);
        const skip = new Set(header.map((h) => h.toLowerCase()));
        while (i < lines.length) {
            const t = String(lines[i]).trim();
            if (!t) {
                i += 1;
                continue;
            }
            if (skip.has(t.toLowerCase())) {
                i += 1;
                continue;
            }
            break;
        }
    }

    for (; i < lines.length; i++) {
        const trimmed = lines[i].replace(/\s+$/g, '').trim();
        if (!trimmed) {
            doc.moveDown(0.08 * scale);
            continue;
        }

        if (isSectionHeader(trimmed, knownTitles)) {
            doc.moveDown(0.22 * scale);
            doc.font(fonts.bold)
                .fontSize(10.5 * scale)
                .fillColor(palette.accent)
                .text(trimmed.toUpperCase(), {
                    characterSpacing: profile.style === 'ats' ? 0.7 * scale : 0.4 * scale,
                    paragraphGap: 0,
                    align: 'left',
                });
            drawSectionRule(doc, palette, scale);
            continue;
        }

        if (isBullet(trimmed)) {
            const body = trimmed.replace(/^[\u2022\-\*\u2013\u2014•–—]\s*/, '');
            doc.font(fonts.regular)
                .fontSize(9.5 * scale)
                .fillColor(palette.body)
                .text(`${bulletChar} ${body}`, {
                    indent: 8 * scale,
                    paragraphGap: 1.0 * scale,
                    lineGap: 0.7 * scale,
                    align: 'left',
                    width: pageContentWidth(doc),
                });
            continue;
        }

        if (isSkillLine(trimmed)) {
            const idx = trimmed.indexOf(':');
            const cat = trimmed.slice(0, idx).trim();
            const rest = trimmed.slice(idx + 1).trim();
            doc.font(fonts.bold).fontSize(9.5 * scale).fillColor(palette.accent).text(`${cat}: `, {
                continued: true,
                align: 'left',
            });
            doc.font(fonts.regular).fontSize(9.5 * scale).fillColor(palette.body).text(rest, {
                paragraphGap: 1.0 * scale,
                lineGap: 0.7 * scale,
                align: 'left',
            });
            continue;
        }

        if (isYearBand(trimmed)) {
            doc.font(fonts.bold).fontSize(9.3 * scale).fillColor(palette.accent).text(trimmed, {
                paragraphGap: 0.9 * scale,
                align: 'left',
            });
            continue;
        }

        const titleDate = splitTitleDate(trimmed);
        if (titleDate?.dates) {
            writeTitleDateLine(doc, titleDate.title, titleDate.dates, palette, fonts, scale);
            continue;
        }

        if (/\|/.test(trimmed) && !trimmed.includes('@')) {
            doc.font(fonts.bold).fontSize(10 * scale).fillColor(palette.accent).text(trimmed, {
                paragraphGap: 1.0 * scale,
                align: 'left',
            });
            continue;
        }

        if (/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec).*\d{4}/i.test(trimmed)) {
            doc.font(fonts.regular).fontSize(9.5 * scale).fillColor(palette.muted).text(trimmed, {
                align: 'left',
                paragraphGap: 0.8 * scale,
            });
            continue;
        }

        doc.font(fonts.regular).fontSize(9.5 * scale).fillColor(palette.body).text(trimmed, {
            paragraphGap: 1.0 * scale,
            lineGap: 0.8 * scale,
            align: 'left',
        });
    }
}

async function renderResumeDoc(text, opts, scale) {
    const margin = Math.max(26, Math.round(34 * Math.min(1, scale + 0.08)));
    const { default: PDFDocument } = await import('pdfkit');

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: { top: margin, bottom: margin, left: margin + 6, right: margin + 6 },
            info: {
                Title: opts.title || 'Tailored Resume',
                Creator: 'WA-BOT Resume Tailor',
            },
            bufferPages: true,
        });

        const fonts = registerResumeFonts(doc, opts.fontPair);
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('error', reject);
        doc.on('end', () => {
            resolve({
                buffer: Buffer.concat(chunks),
                pages: pagesCount,
            });
        });

        paintResume(doc, text, opts, scale, fonts);

        const range = doc.bufferedPageRange();
        const pagesCount = range?.count || 1;
        doc.end();
    });
}

/**
 * @param {string} resumeText
 * @param {{ title?: string, baseText?: string, palette?: object, typography?: object }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function buildResumePdfBuffer(resumeText, opts = {}) {
    const text = normalizeResumeExtract(resumeText);
    if (!text) {
        throw new Error('Empty resume text for PDF');
    }

    const baseNorm = opts.baseText ? normalizeResumeExtract(opts.baseText) : text;
    const knownTitles = extractSectionTitles(baseNorm);
    const baseHeader = extractHeaderLines(baseNorm);
    const profile = detectResumeLayoutProfile(baseNorm);

    const typoDefault = defaultTypographyForStyle(profile.style);
    const typography = {
        family: opts.typography?.family || typoDefault.family,
        headerAlign: opts.typography?.headerAlign || profile.headerAlign || typoDefault.headerAlign,
    };
    profile.headerAlign = typography.headerAlign;

    const palette = resolveResumePalette(profile.style, opts.palette);
    const bulletChar = profile.bullet || '•';
    const fontPair = resolveResumeFontPair(typography.family);

    const shared = {
        title: opts.title,
        knownTitles,
        baseHeader,
        profile,
        palette,
        bulletChar,
        fontPair,
    };

    // Hard 1-page: shrink until PDFKit stays on a single page.
    let scale = 1;
    let best = await renderResumeDoc(text, shared, scale);
    for (let step = 0; step < 16 && best.pages > 1; step++) {
        scale = Math.max(0.58, scale - 0.035);
        best = await renderResumeDoc(text, shared, scale);
    }

    return best.buffer;
}
