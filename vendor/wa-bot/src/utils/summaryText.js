/**
 * Text and JSON hygiene for group recaps.
 *
 * Two things made recaps read half-written:
 *   1. every length cap was a raw `.slice(n)`, so titles, details and wrap-ups
 *      got chopped mid-word;
 *   2. when a model hit its token cap the JSON never closed, `JSON.parse` threw,
 *      and the recap fell back to dumping the raw model text into wrap_up.
 *
 * So: cut on sentence/word boundaries, and repair truncated JSON before giving up.
 */

const SENTENCE_END = /[.!?…]["')\]]?$/;

/** Collapse whitespace and strip stray fence/quote noise from model output. */
export function collapseWhitespace(text) {
    return String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Index just past the last sentence terminator in `text`, or -1. */
function lastSentenceEnd(text) {
    for (let i = text.length - 1; i >= 0; i--) {
        if ('.!?…'.includes(text[i])) {
            // Skip decimals ("2.5") and initials — a terminator is followed by
            // whitespace/end, not a digit.
            const next = text[i + 1];
            if (next && !/[\s"')\]]/.test(next)) continue;
            return i + 1;
        }
    }
    return -1;
}

/**
 * Cut `text` to at most `maxLen` chars without splitting a word or a sentence.
 * Prefers ending on a sentence; falls back to a word boundary with an ellipsis.
 */
export function clampToSentence(text, maxLen) {
    const clean = collapseWhitespace(text);
    if (!clean || clean.length <= maxLen) {
        return clean;
    }

    const window = clean.slice(0, maxLen);
    const end = lastSentenceEnd(window);
    // Only honour a sentence break that keeps most of the budget — otherwise a
    // stray early "." would throw away the whole detail.
    if (end > maxLen * 0.5) {
        return window.slice(0, end).trim();
    }

    const space = window.lastIndexOf(' ');
    const cut = space > maxLen * 0.5 ? space : maxLen;
    return `${window.slice(0, cut).replace(/[\s,;:—–-]+$/, '')}…`;
}

/**
 * Drop a trailing fragment left behind by a truncated model response.
 * A tail that follows a finished sentence but never finishes itself is the
 * piece the token cap ate — keep the complete sentences and lose the stub.
 */
export function dropTrailingFragment(text) {
    const clean = collapseWhitespace(text);
    if (!clean || SENTENCE_END.test(clean)) {
        return clean;
    }
    const end = lastSentenceEnd(clean);
    if (end <= 0) {
        // No finished sentence at all — a short clause is normal for a topic
        // detail, so keep it and let ensureSentenceEnd punctuate it.
        return clean;
    }
    const tail = clean.slice(end).trim();
    // A long unfinished tail is more likely a real second sentence than a stub;
    // keeping it beats silently deleting content the model did write.
    return tail.length <= 60 ? clean.slice(0, end).trim() : clean;
}

// Words a sentence leans on but cannot end on. A tail ending here — or hanging
// off one of them — is the half-sentence a token cap left behind.
const HANGING_WORDS =
    'and|but|so|or|because|when|while|which|who|that|though|although|since|after|before|if|' +
    'as|with|without|for|from|into|onto|about|over|under|the|a|an|to|of|in|on|at|by|is|are|was|' +
    'were|has|have|had|will|would|could|should|their|his|her|its|our|your|my|this|that|these|those';

const HANGING_TAIL_RE = new RegExp(`\\s+(?:${HANGING_WORDS})(?:\\s+\\S+)?$`, 'i');
const CLAUSE_BREAK_RE = new RegExp(`^(.*?)(?:,|\\s+(?:${HANGING_WORDS}))\\s+\\S+$`, 'i');

/**
 * Salvage a sentence the model never finished.
 *
 * Only called when we know the response was cut off, so trimming back to the
 * last clause boundary is safe — it turns "...lost orders when the broker" into
 * "...lost orders" rather than posting a dangling clause.
 */
export function finishFragment(text) {
    let clean = collapseWhitespace(text);
    if (!clean || SENTENCE_END.test(clean)) {
        return clean;
    }

    // A finished sentence earlier in the string wins outright.
    const end = lastSentenceEnd(clean);
    if (end > 0) {
        return clean.slice(0, end).trim();
    }

    // Otherwise cut the unfinished clause off, but only while enough survives to
    // still say something.
    for (let guard = 0; guard < 4; guard++) {
        if (!HANGING_TAIL_RE.test(clean)) break;
        const shortened = clean.replace(HANGING_TAIL_RE, '').trim();
        if (shortened.split(/\s+/).length < 4) break;
        clean = shortened;
    }

    const clause = clean.match(CLAUSE_BREAK_RE);
    if (clause && clause[1].split(/\s+/).length >= 4) {
        clean = clause[1].trim();
    }

    return clean.replace(/[\s,;:—–-]+$/, '');
}

/** Give a sentence a full stop when the model left it bare. */
export function ensureSentenceEnd(text) {
    const clean = collapseWhitespace(text);
    if (!clean || SENTENCE_END.test(clean)) {
        return clean;
    }
    return `${clean.replace(/[\s,;:—–-]+$/, '')}.`;
}

/**
 * Trim → clamp → punctuate. The standard treatment for recap prose.
 * Pass `truncated` when the response is known to have been cut off, so a
 * dangling clause gets removed instead of merely punctuated.
 */
export function tidySentence(text, maxLen, { truncated = false } = {}) {
    const trimmed = truncated ? finishFragment(text) : dropTrailingFragment(text);
    if (!trimmed) return '';
    return ensureSentenceEnd(clampToSentence(trimmed, maxLen));
}

/** Titles are labels, not sentences — clamp on a word boundary, no full stop. */
export function tidyTitle(text, maxLen) {
    return clampToSentence(text, maxLen).replace(/[\s.,;:]+$/, '');
}

/** Scan for structural state so a truncated prefix can be closed off. */
function scanJson(text) {
    const stack = [];
    let inString = false;
    let escaped = false;
    const cutPoints = [];

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') {
                inString = false;
                cutPoints.push(i + 1);
            }
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') {
            stack.pop();
            cutPoints.push(i + 1);
        }
    }
    return { stack, inString, cutPoints };
}

/** Close any string/array/object left open by a truncated response. */
function closeStructures(prefix) {
    const { stack, inString } = scanJson(prefix);
    let out = prefix;
    if (inString) out += '"';
    // A dangling comma or key with no value cannot be closed into valid JSON.
    out = out.replace(/,\s*$/, '');
    if (/:\s*$/.test(out)) out += 'null';
    for (let i = stack.length - 1; i >= 0; i--) {
        out += stack[i] === '{' ? '}' : ']';
    }
    return out;
}

/**
 * Parse model JSON, repairing a response the token cap cut off mid-object.
 * Walks back to the last structurally safe point and closes the braces there,
 * so a truncated recap still yields real topics instead of raw text.
 * @returns {{ value: object, repaired: boolean } | null}
 */
export function parseLooseJson(raw) {
    const text = String(raw ?? '').trim();
    const start = text.indexOf('{');
    if (start < 0) return null;
    const body = text.slice(start);

    try {
        return { value: JSON.parse(body), repaired: false };
    } catch {
        // fall through to repair
    }

    const closed = closeStructures(body);
    try {
        return { value: JSON.parse(closed), repaired: true };
    } catch {
        // fall through to backtracking
    }

    // Longest-first: keep as much of the response as still parses.
    const { cutPoints } = scanJson(body);
    for (let i = cutPoints.length - 1; i >= 0; i--) {
        try {
            return { value: JSON.parse(closeStructures(body.slice(0, cutPoints[i]))), repaired: true };
        } catch {
            continue;
        }
    }
    return null;
}
