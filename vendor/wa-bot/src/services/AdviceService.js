/**
 * Random advice via AdviceSlip API — https://api.adviceslip.com/advice
 */

import axios from 'axios';

const API_URL = 'https://api.adviceslip.com/advice';
const TIMEOUT_MS = 12_000;

class AdviceService {
    /**
     * @returns {Promise<{ id: number, advice: string }>}
     */
    async fetchAdvice() {
        const { data } = await axios.get(API_URL, {
            timeout: TIMEOUT_MS,
            headers: { Accept: 'application/json' },
        });

        const slip = data?.slip;
        const advice = String(slip?.advice || '').trim();
        if (!advice) {
            throw new Error('AdviceSlip returned empty advice');
        }

        return {
            id: slip?.id ?? 0,
            advice,
        };
    }

    formatMessage({ id, advice }) {
        return (
            '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n' +
            '┃  💡 *RANDOM ADVICE* 💡  ┃\n' +
            '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n' +
            `_"${advice}"_\n\n` +
            (id ? `🆔 Advice #${id}\n` : '') +
            '─────────────────────────────\n' +
            '_Powered by AdviceSlip_'
        );
    }

    formatError() {
        return '❌ Could not fetch advice right now. Try again in a moment.';
    }
}

export const adviceService = new AdviceService();
export default AdviceService;
