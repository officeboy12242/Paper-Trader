/**
 * JD → full resume rewrite via AssistLlmRouter (modes: exact | related).
 */

import AssistLlmRouter from './AssistLlmRouter.js';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import {
    buildCoverLetterSystemPrompt,
    buildResumeTailorSystemPrompt,
    buildTailorUserBlock,
} from '../prompts/resumeTailorPrompt.js';

function parseTailorOutput(raw) {
    const text = String(raw || '').trim();
    const tailoredMatch = text.match(/===TAILORED_RESUME===\s*([\s\S]*?)(?====GAPS===|$)/i);
    const gapsMatch = text.match(/===GAPS===\s*([\s\S]*?)(?====KEYWORDS===|$)/i);
    const keywordsMatch = text.match(/===KEYWORDS===\s*([\s\S]*?)$/i);

    let tailored = (tailoredMatch?.[1] || '').trim();
    let gaps = (gapsMatch?.[1] || '').trim();
    let keywords = (keywordsMatch?.[1] || '').trim();

    if (!tailored) {
        // ponytail: if model ignores section headers, treat whole reply as resume body
        tailored = text.replace(/^===.*===\s*/gm, '').trim();
        gaps = gaps || 'Could not parse gaps section — review JD vs resume manually.';
    }

    return { tailored, gaps, keywords };
}

export default class ResumeTailorService {
    constructor(cfg = config, resumeStore = null) {
        this.cfg = cfg;
        this.resumeStore = resumeStore;
        this.llm = new AssistLlmRouter(cfg);
    }

    isConfigured() {
        return this.llm.isConfigured();
    }

    /**
     * @param {{ baseResume: string, jobDescription: string, mode?: 'exact'|'related' }} opts
     */
    async tailor({ baseResume, jobDescription, mode = 'related' }) {
        if (!this.isConfigured()) {
            throw new Error('No LLM configured (set GEMINI / GROQ / NVIDIA / OPENROUTER key)');
        }
        if (!String(baseResume || '').trim()) {
            throw new Error('No base resume saved');
        }
        if (!String(jobDescription || '').trim()) {
            throw new Error('No job description provided');
        }

        const rewriteMode = mode === 'exact' ? 'exact' : 'related';

        const { text, provider, model } = await this.llm.completeChat({
            systemPrompt: buildResumeTailorSystemPrompt(rewriteMode),
            history: [],
            userBlock: buildTailorUserBlock(baseResume, jobDescription, rewriteMode),
            maxTokens: 8192,
            temperature: rewriteMode === 'exact' ? 0.55 : 0.42,
            maxChars: 28_000,
        });

        const parsed = parseTailorOutput(text);
        logger.info(
            `Resume tailor (${rewriteMode}) via ${provider}/${model} (${parsed.tailored.length} chars)`
        );
        return { ...parsed, provider, model, mode: rewriteMode };
    }

    async coverLetter({ baseResume, jobDescription }) {
        if (!this.isConfigured()) {
            throw new Error('No LLM configured (set GEMINI / GROQ / NVIDIA / OPENROUTER key)');
        }
        const { text, provider, model } = await this.llm.completeChat({
            systemPrompt: buildCoverLetterSystemPrompt(),
            history: [],
            userBlock: buildTailorUserBlock(baseResume, jobDescription, 'related'),
            maxTokens: 1200,
            temperature: 0.4,
            maxChars: 4000,
        });
        logger.info(`Cover letter via ${provider}/${model}`);
        return { text: text.trim(), provider, model };
    }
}
