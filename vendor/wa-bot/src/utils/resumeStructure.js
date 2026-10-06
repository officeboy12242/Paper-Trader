/**
 * Per-user resume structure: discover sections from THEIR upload.
 * Soft DEJAM_HINTS only fix PDF extract merges — not a required outline.
 */

/** Optional PDF-unjam hints only (PROFILESUMMARY → PROFILE SUMMARY). */
const DEJAM_HINTS = [
    'PROFILE SUMMARY',
    'PROFESSIONAL SUMMARY',
    'TECHNICAL SKILLS',
    'CORE COMPETENCIES',
    'PROFESSIONAL EXPERIENCE',
    'WORK EXPERIENCE',
    'KEY PROJECTS',
    'RELEVANT EXPERIENCE',
    'EDUCATION AND TRAINING',
    'CERTIFICATIONS AND LICENSES',
];

function isBullet(line) {
    return /^[\u2022\-\*\u2013\u2014•–—]\s*/.test(String(line || '').trim());
}

function looksLikeSkillLine(line) {
    return /^[A-Za-z][A-Za-z0-9 /&+]{1,40}:\s+\S/.test(String(line || '').trim());
}

function looksLikeDateish(line) {
    return /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{4}\s*[–\-—]\s*(?:Present|\d{4}))\b/i.test(
        String(line || '')
    );
}

function isAllCapsHeading(t) {
    const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
    return (
        letters.length >= 3 &&
        t.length <= 52 &&
        t === t.toUpperCase() &&
        /[A-ZÀ-Ÿ]/.test(t) &&
        !/[a-zà-ÿ]/.test(t) &&
        !t.includes('@') &&
        !t.includes('|')
    );
}

function isTitleCaseHeading(t) {
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 4) return false;
    const titleCaseWord = /^[\p{Lu}][\p{L}&/'’.-]*$/u;
    const smallWord = /^(and|of|the|for|in|to|&|und|et|y|de|da|do)$/i;
    return (
        words.every((w) => titleCaseWord.test(w) || smallWord.test(w)) &&
        titleCaseWord.test(words[0]) &&
        !/[.!?]$/.test(t)
    );
}

/**
 * True if this line is a job/school body line (not a section banner).
 * ALL CAPS banners that precede dated jobs still count as sections.
 */
function looksLikeJobOrSchoolLine(line, nextLine = '') {
    const t = String(line || '').trim();
    const next = String(nextLine || '').trim();
    if (!t) return false;
    if (isAllCapsHeading(t)) return false;
    if (looksLikeDateish(t)) return true;
    if (/\b(Engineer|Developer|Intern|Manager|Analyst|Consultant|Director|Architect|Associate)\b/i.test(t) && t.length < 60) {
        return true;
    }
    if (next && looksLikeDateish(next)) return true;
    if (next && /\b(Inc|LLC|Ltd|LLP|Corp|University|Institute|College|Pvt)\b/i.test(next) && t.length < 50) {
        return true;
    }
    return false;
}

/**
 * @param {string} line
 * @param {string[]} [knownFromThisResume]
 * @param {{ nextLine?: string, prevBlank?: boolean, next2?: string }} [ctx]
 */
export function looksLikeSectionHeader(line, knownFromThisResume = [], ctx = {}) {
    const t = String(line || '').trim().replace(/:$/, '');
    if (!t || t.length < 2 || t.length > 52) return false;

    if (knownFromThisResume.some((k) => k.toLowerCase() === t.toLowerCase())) {
        return true;
    }

    if (isBullet(t) || t.includes('@') || t.includes('http') || /^\d/.test(t)) return false;
    if (looksLikeSkillLine(t) && t.length > 28) return false;
    if (t.includes('|') && t.length > 20) return false;
    if (t.includes('\t')) return false;
    if (looksLikeJobOrSchoolLine(t, ctx.nextLine)) return false;

    if (isAllCapsHeading(t)) return true;

    // Title Case / localized banners: need blank line before + content after
    if (isTitleCaseHeading(t) && ctx.prevBlank) {
        const next = String(ctx.nextLine || '').trim();
        const next2 = String(ctx.next2 || '').trim();
        if (!next) return false;
        if (isBullet(next) || looksLikeSkillLine(next) || next.length > 45) return true;
        if (isBullet(next2) || looksLikeDateish(next2) || next2.length > 45) return true;
        // Ausbildung → TU Berlin → dated degree
        if (next.length < 45 && (looksLikeDateish(next2) || isBullet(next2))) return true;
        // Sonstiges → short note
        if (next.length > 0 && next.length <= 80 && !looksLikeDateish(next) && !/@/.test(next)) return true;
    }

    return false;
}

/**
 * Discover this resume's section titles in document order (verbatim casing).
 */
export function extractSectionTitles(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const titles = [];

    for (let i = 0; i < raw.length; i++) {
        const t = raw[i].trim().replace(/:$/, '');
        if (!t) continue;

        let prevBlank = i === 0;
        for (let j = i - 1; j >= 0; j--) {
            if (!raw[j].trim()) {
                prevBlank = true;
                break;
            }
            prevBlank = false;
            break;
        }

        let next = '';
        let next2 = '';
        for (let j = i + 1; j < raw.length; j++) {
            if (!raw[j].trim()) continue;
            if (!next) next = raw[j].trim();
            else {
                next2 = raw[j].trim();
                break;
            }
        }

        // Skip name/contact/headline block at top (ATS: ALL CAPS name → headline | skills → contact)
        if (titles.length === 0 && i < 8) {
            if (/@|linkedin|github/i.test(t)) continue;
            const contactNear =
                /@|linkedin|github|\d{8,}|\+\d/i.test(next) || /@|linkedin|github|\d{8,}|\+\d/i.test(next2);
            // ALL CAPS person name before headline/contact
            if (
                isAllCapsHeading(t) &&
                next &&
                ((/\|/.test(next) && !/@/.test(next)) || contactNear)
            ) {
                continue;
            }
            if (contactNear && !isAllCapsHeading(t)) continue;
            // Headline: Role | skills (not a section)
            if (/\|/.test(t) && !/@/.test(t) && contactNear) continue;
            if (
                !isAllCapsHeading(t) &&
                next &&
                next.length < 40 &&
                !isAllCapsHeading(next) &&
                /@|linkedin|github/i.test(next2)
            ) {
                continue;
            }
        }

        if (!looksLikeSectionHeader(t, titles, { nextLine: next, next2, prevBlank })) continue;
        if (titles.length && titles[titles.length - 1].toLowerCase() === t.toLowerCase()) continue;
        titles.push(t);
    }
    return titles;
}

/** Fix common pdf-parse merges using soft hints + light line heuristics. */
export function normalizeResumeExtract(raw) {
    let text = String(raw || '').replace(/\r\n/g, '\n');

    const hints = [...DEJAM_HINTS].filter((s) => s.includes(' ')).sort((a, b) => b.length - a.length);
    for (const section of hints) {
        const jammed = section.replace(/\s+/g, '');
        text = text.replace(new RegExp(jammed, 'gi'), `\n${section}\n`);
    }

    text = text.replace(
        /\b(Engineer|Developer|Intern|Manager|Analyst|Consultant|Lead|Architect|Scientist|Designer|Specialist|Associate|Director|Officer)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/gi,
        '$1\t$2'
    );

    text = text.replace(/\|/g, ' | ');
    text = text.replace(/\s+\|\s+/g, ' | ');
    text = text.replace(/(^|\n)([–—\-\u2022•])([A-Za-z])/g, '$1$2 $3');
    text = text.replace(/([A-Za-z][A-Za-z /&+]+):([A-Za-z0-9])/g, '$1: $2');

    text = text
        .split('\n')
        .map((line) => {
            if (line.includes('@')) return line.replace(/ {2,}/g, ' ');
            let l = line;
            // ATS: "Title | Company    Sep 2023 - Present" → keep date on same line via tab
            l = l.replace(
                /\s{2,}((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}.*)$/i,
                '\t$1'
            );
            if (/\|/.test(l) && !l.includes('\t')) {
                l = l.replace(
                    /^(.+\|.+?)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}(?:\s*[-–—\(].*)?)$/i,
                    '$1\t$2'
                );
            }
            l = l.replace(/([A-Za-z\)])(\d{4})(\s*[–\-—]\s*(?:Present|\d{4})|\s*$)/g, '$1\t$2$3');
            l = l.replace(/(\d)([A-Z][a-z]{2,})/g, '$1 $2');
            l = l.replace(/\)([A-Z][a-z]{2,})/g, ') $1');
            // Collapse spaces but keep tabs (date separators)
            l = l
                .split('\t')
                .map((part) => part.replace(/ {2,}/g, ' ').trim())
                .join('\t');
            return l;
        })
        .join('\n');

    return text
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
}

export function extractHeaderLines(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const header = [];
    for (let i = 0; i < raw.length && header.length < 5; i++) {
        const line = raw[i].trim();
        if (!line) {
            if (header.length) break;
            continue;
        }
        let next = '';
        let next2 = '';
        for (let j = i + 1; j < raw.length; j++) {
            if (!raw[j].trim()) continue;
            if (!next) next = raw[j].trim();
            else {
                next2 = raw[j].trim();
                break;
            }
        }
        let prevBlank = i === 0;
        for (let j = i - 1; j >= 0; j--) {
            if (!raw[j].trim()) {
                prevBlank = true;
                break;
            }
            prevBlank = false;
            break;
        }

        // ATS name line (ALL CAPS) before headline/contact — keep in header
        if (
            header.length === 0 &&
            isAllCapsHeading(line) &&
            next &&
            ((/\|/.test(next) && !/@/.test(next)) || /@|github|linkedin|\+\d|\d{8,}/i.test(next))
        ) {
            header.push(line);
            continue;
        }
        // Headline under ATS name
        if (
            header.length === 1 &&
            /\|/.test(line) &&
            !/@/.test(line) &&
            /@|github|linkedin|\+\d/i.test(next)
        ) {
            header.push(line);
            continue;
        }

        if (looksLikeSectionHeader(line, [], { nextLine: next, next2, prevBlank })) break;
        header.push(line);
    }
    return header;
}

/**
 * Detect visual layout family from the uploaded resume (ATS vs classic/centered).
 * @param {string} text
 * @returns {{ style: 'ats'|'classic', bullet: string, headerAlign: 'left'|'center' }}
 */
export function detectResumeLayoutProfile(text) {
    const normalized = normalizeResumeExtract(text);
    const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
    const head = lines.slice(0, 6);
    const sample = lines.slice(0, 50).join('\n');

    let ats = 0;
    if (head[0] && isAllCapsHeading(head[0]) && head[0].split(/\s+/).length <= 5) ats += 2;
    if (head[1] && /\|/.test(head[1]) && !/@/.test(head[1])) ats += 2;
    if (head.some((l) => /@/.test(l) && /\|/.test(l) && /(\+?\d|github|linkedin)/i.test(l))) ats += 2;
    if (/^•\s|•\s/m.test(sample)) ats += 1;
    if (/\|\s*[^|\n]{2,60}\t?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(sample)) ats += 2;
    if (/^[A-Za-z].+\|.+\|.+/m.test(sample)) ats += 1; // project: name | stack | link

    const style = ats >= 4 ? 'ats' : 'classic';
    return {
        style,
        bullet: /•/.test(sample) ? '•' : '–',
        // Word ATS templates center the name/headline/contact block
        headerAlign: 'center',
    };
}

/**
 * LAYOUT LOCK from THIS user's base resume (dynamic sections + layout family).
 * @param {string} baseText
 */
export function buildLayoutLockBlock(baseText) {
    const normalized = normalizeResumeExtract(baseText);
    const sections = extractSectionTitles(normalized);
    const header = extractHeaderLines(normalized);
    const profile = detectResumeLayoutProfile(normalized);

    const atsRules =
        profile.style === 'ats'
              ? [
                  '- LAYOUT FAMILY: ATS single-column (like modern ATS resumes).',
                  '- Header: ALL CAPS name, then "Role | skills" headline, then "phone | email | links" — CENTERED.',
                  '- Experience rows: "Job Title | Company<TAB>Mon YYYY - Mon YYYY" on ONE line (dates after a tab).',
                  '- Optional year bands under a role (e.g. "2025", "2024", "Sep 2023 - Dec 2023") then bullets.',
                  '- Projects: "Project Name | tech, stack | github.com/..." then bullets.',
                  `- Bullets must use "${profile.bullet}" (same character as BASE).`,
                  '- Keep the resume concise enough for ONE page (prefer tighter bullets over dropping sections).',
              ]
            : [
                  '- LAYOUT FAMILY: classic resume (name/contact header, section banners, role then dates).',
                  `- Bullets must use "${profile.bullet}" (same character as BASE).`,
              ];

    return [
        'LAYOUT LOCK (must follow — mirror THIS candidate\'s own resume shape):',
        '- Keep name + contact / location lines identical to BASE (do not rewrite contact details).',
        '- Keep the SAME section titles and SAME section ORDER as BASE — including unusual/custom/non-English titles.',
        '- Do NOT force a standard English template (do not rename their sections unless BASE already uses those words).',
        sections.length
            ? `- Section titles in order (copy exactly): ${sections.map((s) => JSON.stringify(s)).join(' → ')}`
            : '- Infer section titles only from BASE; keep them verbatim.',
        header.length ? `- Header lines to keep: ${header.map((h) => JSON.stringify(h)).join(' | ')}` : '',
        ...atsRules,
        '- Preserve BASE skill "Category: items" lines when present.',
        '- Do not invent new sections; do not drop existing BASE sections.',
        '- Plain text only. Each section title alone on its own line (exact casing as BASE).',
        '- Do not put dates alone on the line under a job/project title when BASE had them on the same line.',
    ]
        .filter(Boolean)
        .join('\n');
}
