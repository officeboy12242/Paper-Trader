/**
 * Text progress bar — /ping style on WhatsApp dark theme:
 * bright solid fill (█) + dull stippled empty (░).
 */
export function createProgressBar(percent, length = 10) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const filled = Math.round((clamped / 100) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Terminal line matching /ping: `> CPU  [████░░░░░░] 39.2%`
 */
export function formatProgressLine(label, percent, { decimals = 0 } = {}) {
    const bar = createProgressBar(percent);
    const pctText = decimals > 0
        ? Number(percent).toFixed(decimals)
        : String(Math.round(percent));
    return `> ${label}  [${bar}] ${pctText}%`;
}
