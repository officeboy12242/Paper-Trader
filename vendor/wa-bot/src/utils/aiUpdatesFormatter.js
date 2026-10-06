/**
 * Format one AI update as a WhatsApp card with a complete summary and source.
 */

/**
 * @param {{ title: string, url: string, source?: string }} item
 * @param {{
 *   whatHappened?: string,
 *   industryImpact?: string,
 *   studentCareerAngle?: string[],
 *   projectIdea?: string
 * }} card
 */
export function formatAiUpdateMessage(item, card = {}) {
    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += '⚡ *AI INDUSTRY & CAREER UPDATE*\n';
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    text += `*${item.title}*\n`;
    if (card.whatHappened) {
        text += `\n🧠 *What happened?*\n${card.whatHappened}\n`;
    }
    if (card.industryImpact) {
        text += `\n🏢 *Industry impact*\n${card.industryImpact}\n`;
    }
    if (card.studentCareerAngle?.length) {
        text += '\n🎓 *Student & career angle*\n';
        text += card.studentCareerAngle.map((line) => `• ${line}`).join('\n');
        text += '\n';
    }
    if (card.projectIdea) {
        text += `\n💡 *Project idea*\n${card.projectIdea}\n`;
    }
    if (item.source) {
        text += `\n📰 *Source:* ${item.source}\n`;
    }
    // Full URL remains on its own line so WhatsApp generates a rich preview.
    text += `🔗 *Full preview:* ${item.url}`;
    return text;
}
