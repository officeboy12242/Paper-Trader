/**
 * Format Inshorts articles for WhatsApp — up to 10 separate messages
 */

const HEADER = '⚡️ *TECH FLASH* ⚡️';
const FOOTER = `${'━'.repeat(24)}\n⚡ Powered by CoursesDrivee`;
const DEFAULT_ARTICLE_COUNT = 10;

function escapeWhatsApp(text) {
    return text.replace(/[*_~`]/g, (ch) => `\\${ch}`);
}

function buildBlock(article, summaryMaxLen = 400) {
    let summary = article.summary || '';
    if (summaryMaxLen > 0 && summary.length > summaryMaxLen) {
        summary = `${summary.slice(0, Math.max(0, summaryMaxLen - 3))}...`;
    }
    return `📌 *${escapeWhatsApp(article.title)}*\n\n💬 ${escapeWhatsApp(summary)}`;
}

/**
 * Up to 10 articles as separate WhatsApp messages.
 * @param {Array<{title: string, summary: string}>} articles
 * @param {number} max
 * @returns {string[]}
 */
export function formatNewsArticleMessages(articles, max = DEFAULT_ARTICLE_COUNT) {
    const arts = articles.slice(0, max);
    if (!arts.length) {
        return [];
    }

    return arts.map((art, index) => {
        const label = `*${index + 1}/${arts.length}*`;
        const block = buildBlock(art, 400);
        if (index === 0) {
            return `${HEADER} ${label}\n\n${block}`;
        }
        if (index === arts.length - 1) {
            return `${label}\n\n${block}\n\n${FOOTER}`;
        }
        return `${label}\n\n${block}`;
    });
}

/** @deprecated Use formatNewsArticleMessages */
export function formatNewsPost(articles) {
    const parts = formatNewsArticleMessages(articles);
    return parts[0] || '';
}

/** @deprecated Use formatNewsArticleMessages */
export function formatNewsPosts(articles) {
    return formatNewsArticleMessages(articles);
}
