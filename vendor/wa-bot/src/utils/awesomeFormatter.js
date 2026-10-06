/**
 * Format awesome-list GitHub repo messages (link-preview friendly).
 */

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function truncate(text, max = 200) {
    if (!text || text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
}

/**
 * @param {{ fullName: string, description: string, language?: string, totalStars?: string, forks?: string, url: string }} list
 * @param {number} index - 1-based
 * @param {number} total
 */
export function formatAwesomeListMessage(list, index = 1, total = 1) {
    const num = NUMBER_EMOJI[index - 1] || `#${index}`;

    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += `⭐ *AWESOME LIST* ${num}/${total}\n`;
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    text += `*${list.fullName}*\n`;
    text += `${truncate(list.description)}\n\n`;
    if (list.language && list.language !== '—') {
        text += `💻 *Language:* ${list.language}\n`;
    }
    if (list.totalStars) {
        text += `⭐ *Stars:* ${list.totalStars}\n`;
    }
    if (list.forks) {
        text += `🍴 *Forks:* ${list.forks}\n`;
    }
    text += `\n${list.url}`;
    return text;
}
