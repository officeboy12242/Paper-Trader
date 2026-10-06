/**
 * Sample fill colors from a text-based PDF (Word/ATS resumes).
 * Used so tailored PDF export can reuse the uploaded resume palette.
 */

import zlib from 'zlib';

/** Word ATS template defaults (matches common dark-teal ATS resumes). */
export const ATS_DEFAULT_PALETTE = {
    name: '#003a57',
    accent: '#005682',
    rule: '#b7c7d3',
    body: '#1f1f1f',
    muted: '#555555',
};

export const CLASSIC_DEFAULT_PALETTE = {
    name: '#111111',
    accent: '#111111',
    rule: '#222222',
    body: '#222222',
    muted: '#333333',
};

function toHex(r, g, b) {
    return (
        '#' +
        [r, g, b]
            .map((x) =>
                Math.max(0, Math.min(255, Math.round(Number(x) * 255)))
                    .toString(16)
                    .padStart(2, '0')
            )
            .join('')
    );
}

function luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isNearGray(r, g, b, eps = 0.04) {
    return Math.abs(r - g) < eps && Math.abs(g - b) < eps && Math.abs(r - b) < eps;
}

/**
 * @param {Buffer} buffer
 * @returns {{ name: string, accent: string, rule: string, body: string, muted: string }|null}
 */
export function extractPdfColorPalette(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 100) return null;

    const chromas = new Map(); // hex -> { count, lum, r,g,b }
    const grays = new Map(); // level 0-1 -> count

    for (let i = 0; i < buffer.length - 6; i++) {
        if (
            buffer[i] !== 0x73 ||
            buffer[i + 1] !== 0x74 ||
            buffer[i + 2] !== 0x72 ||
            buffer[i + 3] !== 0x65 ||
            buffer[i + 4] !== 0x61 ||
            buffer[i + 5] !== 0x6d
        ) {
            continue;
        }
        let start = i + 6;
        if (buffer[start] === 0x0d) start += 1;
        if (buffer[start] === 0x0a) start += 1;
        let end = -1;
        for (let j = start; j < Math.min(buffer.length - 9, start + 800_000); j++) {
            if (buffer[j] === 0x65 && buffer.toString('ascii', j, j + 9) === 'endstream') {
                end = j;
                break;
            }
        }
        if (end < 0) continue;
        let data;
        try {
            data = zlib.inflateSync(buffer.subarray(start, end));
        } catch {
            continue;
        }
        const t = data.toString('latin1');
        for (const m of t.matchAll(/([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+rg\b/g)) {
            const r = Number(m[1]);
            const g = Number(m[2]);
            const b = Number(m[3]);
            if (![r, g, b].every((n) => Number.isFinite(n))) continue;
            if (isNearGray(r, g, b)) {
                const level = (r + g + b) / 3;
                const key = level.toFixed(3);
                grays.set(key, (grays.get(key) || 0) + 1);
            } else {
                const hex = toHex(r, g, b);
                const prev = chromas.get(hex) || { count: 0, lum: luminance(r, g, b), r, g, b };
                prev.count += 1;
                chromas.set(hex, prev);
            }
        }
        for (const m of t.matchAll(/([0-9.]+)\s+g\b/g)) {
            const level = Number(m[1]);
            if (!Number.isFinite(level) || level > 0.95) continue;
            const key = level.toFixed(3);
            grays.set(key, (grays.get(key) || 0) + 1);
        }
    }

    if (!chromas.size && !grays.size) return null;

    const chromaList = [...chromas.entries()]
        .map(([hex, meta]) => ({ hex, ...meta }))
        .sort((a, b) => a.lum - b.lum);

    const grayList = [...grays.entries()]
        .map(([k, count]) => ({ level: Number(k), count }))
        .filter((g) => g.level < 0.9)
        .sort((a, b) => a.level - b.level);

    const darkChromas = chromaList.filter((c) => c.lum < 0.55);
    const lightChromas = chromaList.filter((c) => c.lum >= 0.55);

    const name = darkChromas[0]?.hex || ATS_DEFAULT_PALETTE.name;
    const accent =
        [...darkChromas].sort((a, b) => b.count - a.count)[0]?.hex ||
        darkChromas[0]?.hex ||
        name;
    const rule = [...lightChromas].sort((a, b) => b.count - a.count)[0]?.hex || accent;

    const bodyGray = grayList[0];
    const mutedGray = grayList.find((g) => g.level > (bodyGray?.level || 0) + 0.08) || grayList[1];

    const body = bodyGray ? toHex(bodyGray.level, bodyGray.level, bodyGray.level) : ATS_DEFAULT_PALETTE.body;
    const muted = mutedGray
        ? toHex(mutedGray.level, mutedGray.level, mutedGray.level)
        : ATS_DEFAULT_PALETTE.muted;

    return { name, accent, rule, body, muted };
}

/**
 * @param {'ats'|'classic'} style
 * @param {object|null|undefined} stored
 */
export function resolveResumePalette(style, stored) {
    const base = style === 'ats' ? ATS_DEFAULT_PALETTE : CLASSIC_DEFAULT_PALETTE;
    if (!stored || typeof stored !== 'object') return { ...base };
    return {
        name: stored.name || base.name,
        accent: stored.accent || base.accent,
        rule: stored.rule || base.rule,
        body: stored.body || base.body,
        muted: stored.muted || base.muted,
    };
}
