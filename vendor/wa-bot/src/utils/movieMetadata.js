const VIDEO_EXTENSIONS = ['mkv', 'mp4', 'avi', 'mov', 'wmv', 'webm', 'm4v', 'ts', 'flv', 'mpg', 'mpeg', 'm3u', 'm3u8'];

export const LANGUAGE_ALIASES = {
    jap: 'Japanese',
    japanese: 'Japanese',
    jpn: 'Japanese',
    eng: 'English',
    english: 'English',
    hin: 'Hindi',
    hindi: 'Hindi',
    h: 'Hindi',
    tam: 'Tamil',
    tel: 'Telugu',
    mal: 'Malayalam',
    kan: 'Kannada',
    ben: 'Bengali',
    pun: 'Punjabi',
    mar: 'Marathi',
    guj: 'Gujarati',
    urd: 'Urdu',
};

/**
 * Display title from a release filename — strip file extensions only, keep quality/audio tags intact.
 * @param {string} raw
 * @returns {string}
 */
export function filenameToDisplayTitle(raw) {
    if (!raw) return '';
    let name = String(raw).trim();
    if (!name) return '';

    let prev;
    do {
        prev = name;
        name = name.replace(new RegExp(`\\.(${VIDEO_EXTENSIONS.join('|')})$`, 'i'), '');
    } while (name !== prev);

    return name.trim() || String(raw).trim();
}

/**
 * @param {string} name
 * @returns {string}
 */
export function qualityFromFilename(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('2160p') || n.includes('4k')) return '4K';
    if (n.includes('1080p')) return '1080p';
    if (n.includes('1440p')) return '1440p';
    if (n.includes('720p') && n.includes('hevc')) return '720p HEVC';
    if (n.includes('720p')) return '720p';
    if (n.includes('480p')) return '480p';
    return '';
}

function normalizeLanguageToken(token) {
    const cleaned = String(token || '').trim();
    if (!cleaned) return '';
    return LANGUAGE_ALIASES[cleaned.toLowerCase()] || cleaned;
}

function languagesFromBrackets(filename) {
    for (const match of String(filename || '').matchAll(/\[([^\]]+)\]/g)) {
        const inner = match[1];
        if (!/(?:tam|tel|hin|eng|mal|kan|jap|ben|pun|mar|guj|urd|\+|,)/i.test(inner)) {
            continue;
        }
        const langs = inner
            .split(/\+|,/)
            .map(normalizeLanguageToken)
            .filter(Boolean);
        if (langs.length) {
            return langs.join(' + ');
        }
    }
    return '';
}

const LANGUAGE_PATTERNS = [
    { re: /\bDual[\s._-]?Audio\b/i, label: 'Dual Audio' },
    { re: /\bMulti[\s._-]?Audio\b/i, label: 'Multi Audio' },
    { re: /\[(Multi|MULTI)\]/i, label: 'Multi Audio' },
    { re: /\bHindi\b/i, label: 'Hindi' },
    { re: /\bEnglish\b/i, label: 'English' },
    { re: /\bTamil\b/i, label: 'Tamil' },
    { re: /\bTelugu\b/i, label: 'Telugu' },
    { re: /\bMalayalam\b/i, label: 'Malayalam' },
    { re: /\bKannada\b/i, label: 'Kannada' },
    { re: /\bBengali\b/i, label: 'Bengali' },
    { re: /\bPunjabi\b/i, label: 'Punjabi' },
    { re: /\bMarathi\b/i, label: 'Marathi' },
    { re: /\bGujarati\b/i, label: 'Gujarati' },
    { re: /\bUrdu\b/i, label: 'Urdu' },
];

const AUDIO_CODEC_PATTERNS = [
    { re: /\bDD\+[\s._-]?5\.1\b/i, label: 'DD+ 5.1' },
    { re: /\bDDP[\s._-]?5\.1\b/i, label: 'DDP 5.1' },
    { re: /\bDD[\s._-]?5\.1\b/i, label: 'DD 5.1' },
    { re: /\bDD[\s._-]?2\.0\b/i, label: 'DD 2.0' },
    { re: /\bAtmos\b/i, label: 'Atmos' },
    { re: /\bAAC[\s._-]?5\.1\b/i, label: 'AAC 5.1' },
    { re: /\bAAC[\s._-]?2\.0\b/i, label: 'AAC 2.0' },
    { re: /\bE[\s._-]?AC[\s._-]?3\b/i, label: 'EAC3' },
    { re: /\bAC3\b/i, label: 'AC3' },
    { re: /\bAAC\b/i, label: 'AAC' },
    { re: /\bMP3\b/i, label: 'MP3' },
];

/**
 * Extract audio language/codec hints from a release filename.
 * @param {string} filename
 * @returns {string}
 */
export function audioFromFilename(filename) {
    if (!filename) return '';

    const fromBrackets = languagesFromBrackets(filename);

    const hasDual = /\bDual[\s._-]?Audio\b/i.test(filename);
    const hasMulti = /\bMulti[\s._-]?Audio\b/i.test(filename);

    const languages = [];
    if (fromBrackets) {
        for (const lang of fromBrackets.split(' + ')) {
            if (lang && !languages.includes(lang)) {
                languages.push(lang);
            }
        }
    }

    if (hasDual) {
        if (!languages.includes('Dual Audio')) languages.push('Dual Audio');
    } else if (hasMulti) {
        if (!languages.includes('Multi Audio')) languages.push('Multi Audio');
    } else if (!fromBrackets) {
        for (const { re, label } of LANGUAGE_PATTERNS) {
            if (re.test(filename) && !languages.includes(label)) {
                languages.push(label);
            }
        }
    }

    if (hasDual || hasMulti) {
        for (const { re, label } of LANGUAGE_PATTERNS) {
            if (label === 'Dual Audio' || label === 'Multi Audio') continue;
            if (re.test(filename) && !languages.includes(label)) {
                languages.push(label);
            }
        }
    }

    const codecs = [];
    for (const { re, label } of AUDIO_CODEC_PATTERNS) {
        if (!re.test(filename) || codecs.includes(label)) continue;
        if (label === 'AAC' && codecs.some((c) => c.startsWith('AAC'))) continue;
        if (label === 'DD 5.1' && codecs.some((c) => c.startsWith('DD'))) continue;
        codecs.push(label);
    }

    const parts = [];
    if (languages.length) parts.push(languages.join(' + '));
    if (codecs.length) parts.push(codecs.join(', '));
    return parts.join(' • ');
}
