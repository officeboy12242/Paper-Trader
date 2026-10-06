/**
 * Format individual GitHub trending repo messages for WhatsApp link previews.
 */

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function truncate(text, max = 200) {
    if (!text || text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
}

function starsTodaySuffix(repo) {
    if (!repo.starsToday) return '';
    const count = repo.starsToday.replace(/\s*stars?\s*today/i, '').trim();
    return count ? ` (+${count} today)` : '';
}

const CATEGORY_HEADERS = {
    trending: '🔥 *GITHUB TRENDING*',
    popular: '⭐ *GITHUB POPULAR*',
    underrated: '💎 *GITHUB HIDDEN GEM*',
    college: '🎓 *COLLEGE / RESUME PROJECT*',
};

function categoryHeader(repo) {
    return CATEGORY_HEADERS[repo.category] || CATEGORY_HEADERS.trending;
}

/**
 * @param {{ fullName: string, description: string, language: string, starsToday?: string, totalStars?: string, forks?: string, url: string, category?: string }} repo
 * @param {number} index - 1-based position
 * @param {number} total
 */
export function formatGitHubRepoMessage(repo, index = 1, total = 5) {
    const num = NUMBER_EMOJI[index - 1] || `#${index}`;

    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += `${categoryHeader(repo)} ${num}/${total}\n`;
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    text += `*${repo.fullName}*\n`;
    text += `${truncate(repo.description)}\n\n`;
    if (repo.language && repo.language !== '—') {
        text += `💻 *Language:* ${repo.language}\n`;
    }
    if (repo.totalStars) {
        text += `⭐ *Stars:* ${repo.totalStars}${starsTodaySuffix(repo)}\n`;
    }
    if (repo.forks) {
        text += `🍴 *Forks:* ${repo.forks}\n`;
    }
    if (repo.whyNow) {
        text += `🏷 *Why now:* ${repo.whyNow}\n`;
    }
    // Full URL on its own line — WhatsApp generates link preview from this
    text += `\n${repo.url}`;
    return text;
}

/**
 * @param {Array<object>} repos
 */
export function formatGitHubTrendingMessage(repos) {
    if (!repos?.length) {
        return '📭 No GitHub trending repos found right now.';
    }
    return repos.map((repo, i) => formatGitHubRepoMessage(repo, i + 1, repos.length)).join('\n\n');
}
