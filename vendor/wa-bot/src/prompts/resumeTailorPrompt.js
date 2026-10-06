/**
 * Prompts for full-resume JD rewrite (two modes: exact vs related).
 * Layout locked to base resume section order/titles for PDF format match.
 */

import { buildLayoutLockBlock } from '../utils/resumeStructure.js';

export function buildResumeTailorSystemPrompt(mode = 'related') {
    const exact = mode === 'exact';

    const sharedRules = [
        'HARD FACTS (never break):',
        '- Keep real employers, companies, schools, degree names, and employment/education dates from the BASE RESUME.',
        '- Do NOT invent employers, companies, degrees, certifications, or employment periods that are absent from the base resume.',
        '- Tools/skills the candidate never had go ONLY in ===GAPS=== — never fake them into Experience.',
        '',
        'OUTPUT SCOPE:',
        '- Rewrite the COMPLETE resume end-to-end (summary, skills, every role, projects, education, certifications).',
        '- Never only edit the overview.',
        '- Prefer concrete bullets (action + scope + outcome).',
        '- Plain text only (no markdown).',
        '',
        'FORMAT / LAYOUT (critical for PDF export):',
        '- Obey the LAYOUT LOCK block in the user message (ATS vs classic family).',
        '- Preserve BASE section titles and order exactly (including custom / non-English names — never force a fixed English outline).',
        '- Preserve name + contact/location header exactly.',
        '- Skills as "Category: items" lines when BASE uses that.',
        '- If BASE is ATS: keep centered "Role | skills" headline, "phone | email | links", "Title | Company<TAB>dates", year bands, "Project | stack | url", same bullet character, and fit ONE page.',
        '- If BASE is classic: "Job Title<TAB>dates" then company line, then bullets — mirror BASE punctuation; prefer ONE page.',
        '',
        'Respond with exactly these sections and headings:',
        '===TAILORED_RESUME===',
        '(full resume body — all sections, layout-locked)',
        '===GAPS===',
        '(bullet list of JD must-haves not evidenced in BASE; or "None")',
        '===KEYWORDS===',
        '(comma-separated JD keywords woven through the rewrite)',
    ];

    if (exact) {
        return [
            'You completely rewrite resumes so the WHOLE document matches a job description as closely as possible.',
            'MODE: EXACT — ~75% JD language / framing, ~25% BASE facts, same visual structure as BASE.',
            '',
            'BLEND TARGET (critical):',
            '- About 75% of summary, skills phrasing, headlines, and EVERY experience/project bullet must use JD vocabulary, responsibilities, and priority order.',
            '- About 25% stays from BASE: only hard facts (employers, schools, degrees, real dates, metrics you already had) and layout locks.',
            '- Do NOT lightly polish BASE bullets. Replace them. If a BASE bullet is unrelated to the JD, drop or heavily rewrite it into a JD-aligned bullet supported by BASE scope.',
            '- Prefer JD synonyms and keyword density over keeping original sentence structure.',
            '- Summary and skills lists should read like they were written for THIS JD first; BASE is only the evidence source.',
            '',
            'GOALS:',
            '- Mirror JD wording wherever BASE facts support it (stack, domain, duties, soft skills named in JD).',
            '- Reframe titles toward JD-aligned titles ONLY when BASE work scope supports it.',
            '- Rewrite nearly every experience bullet from scratch in JD voice — not copy-edit.',
            '- Missing requirements go in GAPS only (never invent employers/tools into Experience).',
            '',
            ...sharedRules,
        ].join('\n');
    }

    return [
        'You fully rewrite resumes so the WHOLE document is strongly related to a job description.',
        'MODE: RELATED — natural HR-ready voice + strong ATS keyword coverage, same visual structure as BASE.',
        '',
        'ATS + HR OPTIMIZATION (critical for Related):',
        '- Extract JD must-have skills, tools, domains, and soft skills; weave the important ones naturally through summary, skills, and bullets (exact phrases + common ATS synonyms).',
        '- Put JD-priority skills first in skill categories; demote or shorten BASE skills irrelevant to this JD.',
        '- Write bullets HR likes: strong action verb + what you built/owned + scope/stack + outcome/impact (use BASE metrics when present).',
        '- Use clean, scannable phrasing — no fluff, no first person, no keyword stuffing or awkward JD paste.',
        '- Mirror JD role language where BASE scope supports it (e.g. "backend services", "ETL", "REST APIs") so ATS token match rises without sounding fake.',
        '- Summary should read as a short pitch for THIS role: 3–5 lines, JD keywords included naturally.',
        '- Recycle high-value JD nouns into multiple sections (skills + 1–2 bullets + summary) so ATS and recruiters both see them.',
        '- List every high-value JD keyword you actually used in ===KEYWORDS===; put unsupported must-haves only in ===GAPS===.',
        '',
        'GOALS:',
        '- Rewrite all sections so they clearly relate to the JD while staying believable.',
        '- Emphasize transferable work; cut or shrink unrelated fluff.',
        '- Keep professional, conversational tone — optimized for both ATS parsers and human HR skim.',
        '',
        ...sharedRules,
    ].join('\n');
}

export function buildCoverLetterSystemPrompt() {
    return [
        'Write a short professional cover letter for WhatsApp delivery.',
        'HARD RULES:',
        '- Ground every claim in the BASE RESUME and JOB DESCRIPTION.',
        '- Do not invent experience, metrics, or employers.',
        '- 250–400 words, plain text, no markdown headers.',
        'Respond with only the letter body.',
    ].join('\n');
}

export function buildTailorUserBlock(baseResume, jobDescription, mode = 'related') {
    const exact = mode === 'exact';
    const modeLine = exact
        ? 'REWRITE MODE: EXACT — target ~75% JD wording/priorities and ~25% BASE hard facts; keep BASE layout/format locks. Do not preserve original bullet phrasing.'
        : 'REWRITE MODE: RELATED — natural rewrite optimized for ATS keyword match + HR readability; keep BASE layout/format locks. Weave JD keywords throughout without stuffing.';

    const baseLabel = exact
        ? 'BASE RESUME (facts + layout only — Exact mode: do not keep most original wording):'
        : 'BASE RESUME (facts, proof points, and layout — Related mode: rewrite in stronger HR/ATS language):';

    const jdLabel = exact
        ? 'JOB DESCRIPTION (Exact mode: primary source for wording, keywords, and emphasis — ~75% of rewrite):'
        : 'JOB DESCRIPTION (Related mode: source of priority keywords and role language to weave in naturally for ATS + HR):';

    const closer = exact
        ? 'Produce the full layout-locked rewritten resume under ===TAILORED_RESUME=== now. Exact: heavy JD rewrite; keep only BASE employers/dates/schools/real metrics.'
        : 'Produce the full layout-locked rewritten resume under ===TAILORED_RESUME=== now. Related: strong ATS keyword coverage + clear HR-friendly bullets; list woven keywords in ===KEYWORDS===.';

    return [
        modeLine,
        '',
        buildLayoutLockBlock(baseResume),
        '',
        baseLabel,
        '---',
        String(baseResume || '').slice(0, 60_000),
        '---',
        '',
        jdLabel,
        '---',
        String(jobDescription || '').slice(0, 20_000),
        '---',
        '',
        closer,
    ].join('\n');
}

/** @returns {'exact'|'related'|null} */
export function parseRewriteMode(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    if (/^(1|exact|full|complete|max|e)\b/.test(t) || t === 'exact as per jd' || t.includes('exact')) {
        return 'exact';
    }
    if (/^(2|related|relatable|relate|soft|r)\b/.test(t) || t.includes('relat')) {
        return 'related';
    }
    return null;
}

/** @returns {'txt'|'pdf'|null} */
export function parseExportFormat(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    if (/^(1|txt|text|plain)\b/.test(t) || t === 'txt') {
        return 'txt';
    }
    if (/^(2|pdf)\b/.test(t) || t === 'pdf' || t.includes('pdf')) {
        return 'pdf';
    }
    // avoid matching "related" via includes('text')
    if (t.includes('text') && !t.includes('related')) {
        return 'txt';
    }
    return null;
}
