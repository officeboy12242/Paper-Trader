/**
 * Horoscope Service
 * Fetches daily horoscope using free API
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const ZODIAC_SIGNS = [
    'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
    'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces'
];

const ZODIAC_EMOJIS = {
    aries: '♈',
    taurus: '♉',
    gemini: '♊',
    cancer: '♋',
    leo: '♌',
    virgo: '♍',
    libra: '♎',
    scorpio: '♏',
    sagittarius: '♐',
    capricorn: '♑',
    aquarius: '♒',
    pisces: '♓'
};

const ZODIAC_DATES = {
    aries: 'Mar 21 - Apr 19',
    taurus: 'Apr 20 - May 20',
    gemini: 'May 21 - Jun 20',
    cancer: 'Jun 21 - Jul 22',
    leo: 'Jul 23 - Aug 22',
    virgo: 'Aug 23 - Sep 22',
    libra: 'Sep 23 - Oct 22',
    scorpio: 'Oct 23 - Nov 21',
    sagittarius: 'Nov 22 - Dec 21',
    capricorn: 'Dec 22 - Jan 19',
    aquarius: 'Jan 20 - Feb 18',
    pisces: 'Feb 19 - Mar 20'
};

const LUCKY_COLORS = [
    'Red', 'Blue', 'Green', 'Gold', 'Purple', 'Orange',
    'Pink', 'Yellow', 'Teal', 'Silver', 'Dark Green', 'Coral',
];

class HoroscopeService {
    constructor() {
        this._cache = new Map();
        this._cacheExpiry = 6 * 60 * 60 * 1000; // 6 hours cache
        /** Bump when luck extras logic changes */
        this._cacheVersion = 'v3';
    }

    /**
     * Normalize and validate zodiac sign input
     */
    normalizeSign(input) {
        if (!input) return null;
        const normalized = input.toLowerCase().trim();
        
        // Handle common abbreviations
        const aliases = {
            'cap': 'capricorn',
            'sag': 'sagittarius',
            'sagi': 'sagittarius',
            'aqua': 'aquarius',
            'scorp': 'scorpio',
            'leo': 'leo',
            'gem': 'gemini',
            'ari': 'aries',
            'tau': 'taurus',
            'can': 'cancer',
            'vir': 'virgo',
            'lib': 'libra',
            'pis': 'pisces'
        };
        
        if (aliases[normalized]) return aliases[normalized];
        if (ZODIAC_SIGNS.includes(normalized)) return normalized;
        
        // Partial match
        const match = ZODIAC_SIGNS.find(s => s.startsWith(normalized));
        return match || null;
    }

    /**
     * Get cache key for today
     */
    _getCacheKey(sign) {
        const today = new Date().toISOString().split('T')[0];
        return `${this._cacheVersion}_${sign}_${today}`;
    }

    _formatDate() {
        return new Date().toLocaleDateString('en-IN', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    }

    /**
     * Parse lucky number/color/compatibility from prediction text when API omits fields.
     */
    _parseExtrasFromText(text) {
        if (!text) return {};

        const extras = {};
        const numMatch = text.match(/lucky number[:\s]+(\d+)/i);
        const colorMatch = text.match(/lucky color[:\s]+([A-Za-z ]+?)(?:[,.]|$|\s+lucky|\s+compatible)/i);
        const compatMatch = text.match(/compatible sign[:\s]+([A-Za-z]+)/i);

        if (numMatch) extras.luckyNumber = Number(numMatch[1]);
        if (colorMatch) extras.luckyColor = colorMatch[1].trim();
        if (compatMatch) extras.compatibility = compatMatch[1].trim();

        return extras;
    }

    /**
     * Merge Vedika extras only when the API actually returned the requested sign.
     * Vedika sandbox often ignores `sign` and repeats the same luck fields for everyone.
     */
    _resolveExtras(vedikaPayload, sign) {
        const generated = this._generateDailyLuck(sign);
        if (!vedikaPayload) return generated;

        const apiSign = this.normalizeSign(vedikaPayload.apiSign);
        const signMatched = apiSign === sign;

        if (!signMatched) {
            logger.debug(
                `Vedika luck ignored for ${sign} (API returned ${vedikaPayload.apiSign || 'unknown'}) — using daily seed`
            );
            return generated;
        }

        const parsed = this._parseExtrasFromText(vedikaPayload.horoscope || '');

        return {
            luckyNumber: vedikaPayload.luckyNumber ?? parsed.luckyNumber ?? generated.luckyNumber,
            luckyColor: vedikaPayload.luckyColor ?? parsed.luckyColor ?? generated.luckyColor,
            mood: vedikaPayload.mood ?? generated.mood,
            compatibility: vedikaPayload.compatibility ?? parsed.compatibility ?? generated.compatibility,
        };
    }

    /**
     * Deterministic per-sign daily luck (stable for the day, different across signs).
     */
    _generateDailyLuck(sign) {
        const today = new Date().toISOString().split('T')[0];
        const signIndex = Math.max(0, ZODIAC_SIGNS.indexOf(sign));

        const hashSeed = (seed) => {
            let hash = 2166136261;
            for (let i = 0; i < seed.length; i++) {
                hash ^= seed.charCodeAt(i);
                hash = Math.imul(hash, 16777619);
            }
            return Math.abs(hash >>> 0);
        };

        const numHash = hashSeed(`${sign}|num|${today}`);
        const colorHash = hashSeed(`${sign}|color|${today}`);
        const moodHash = hashSeed(`${sign}|mood|${today}`);
        const matchHash = hashSeed(`${sign}|match|${today}`);

        const moods = ['Optimistic', 'Focused', 'Calm', 'Energetic', 'Reflective', 'Confident', 'Creative'];
        // Avoid matching the same sign as itself
        const matchIndex = (signIndex + 1 + (matchHash % (ZODIAC_SIGNS.length - 1))) % ZODIAC_SIGNS.length;

        return {
            luckyNumber: (numHash % 99) + 1,
            luckyColor: LUCKY_COLORS[colorHash % LUCKY_COLORS.length],
            mood: moods[moodHash % moods.length],
            compatibility: ZODIAC_SIGNS[matchIndex],
        };
    }

    async _fetchOhmanda(sign) {
        const response = await axios.get(
            `https://ohmanda.com/api/horoscope/${sign}/`,
            { timeout: 10000 }
        );

        const text = String(response.data?.horoscope || '').trim();
        if (!text) {
            throw new Error('Ohmanda returned empty horoscope');
        }

        return text;
    }

    async _fetchHoroscopeApp(sign) {
        const titleSign = sign.charAt(0).toUpperCase() + sign.slice(1);
        const response = await axios.get(
            'https://horoscope-app-api.vercel.app/api/v1/get-horoscope/daily',
            { params: { sign: titleSign, day: 'TODAY' }, timeout: 10000 }
        );

        const text = String(response.data?.data?.horoscope || '').trim();
        if (!text) {
            throw new Error('Invalid horoscope-app response');
        }

        return text;
    }

    async _fetchVedikaExtras(sign) {
        const response = await axios.get(
            'https://api.vedika.io/sandbox/horoscope/daily',
            { params: { sign }, timeout: 10000 }
        );

        const data = response.data?.data;
        if (!data) {
            throw new Error('Invalid Vedika response');
        }

        return {
            horoscope: data.prediction?.trim() || '',
            apiSign: data.sign || null,
            luckyNumber: data.luckyNumber ?? data.lucky_number,
            luckyColor: data.luckyColor ?? data.lucky_color,
            mood: data.mood,
            compatibility: data.compatibility ?? data.compatibleSign ?? data.compatible_sign,
        };
    }

    _buildDiagnostics(ohmandaResult, vedikaResult, appResult) {
        /** @type {{ source: string, ok: boolean, reason?: string, sample?: string }[]} */
        const items = [];

        if (ohmandaResult.status === 'fulfilled') {
            items.push({
                source: 'ohmanda.com',
                ok: true,
                reason: 'ok',
                sample: String(ohmandaResult.value).slice(0, 80),
            });
        } else {
            const reason = ohmandaResult.reason?.message || String(ohmandaResult.reason || 'failed');
            items.push({
                source: 'ohmanda.com',
                ok: false,
                reason,
            });
        }

        if (vedikaResult.status === 'fulfilled') {
            const text = vedikaResult.value?.horoscope || '';
            items.push({
                source: 'vedika.io',
                ok: Boolean(text),
                reason: text ? 'ok' : 'empty prediction',
                sample: text.slice(0, 80),
            });
        } else {
            items.push({
                source: 'vedika.io',
                ok: false,
                reason: vedikaResult.reason?.message || String(vedikaResult.reason || 'failed'),
            });
        }

        if (appResult.status === 'fulfilled') {
            items.push({
                source: 'horoscope-app-api',
                ok: true,
                reason: 'ok',
                sample: String(appResult.value).slice(0, 80),
            });
        } else {
            items.push({
                source: 'horoscope-app-api',
                ok: false,
                reason: appResult.reason?.message || String(appResult.reason || 'failed'),
            });
        }

        return items;
    }

    async _probeSources(normalizedSign) {
        const [ohmandaResult, vedikaResult, appResult] = await Promise.allSettled([
            this._fetchOhmanda(normalizedSign),
            this._fetchVedikaExtras(normalizedSign),
            this._fetchHoroscopeApp(normalizedSign),
        ]);

        return {
            ohmandaResult,
            vedikaResult,
            appResult,
            diagnostics: this._buildDiagnostics(ohmandaResult, vedikaResult, appResult),
        };
    }

    /**
     * Live probe of all horoscope APIs (for auto-heal diagnostics).
     */
    async diagnoseSources(sign) {
        const normalizedSign = this.normalizeSign(sign);
        if (!normalizedSign) {
            return { error: 'invalid_sign', diagnostics: [] };
        }

        const { diagnostics } = await this._probeSources(normalizedSign);
        return { sign: normalizedSign, diagnostics };
    }

    /**
     * Fetch horoscope from API
     */
    async fetchHoroscope(sign) {
        const normalizedSign = this.normalizeSign(sign);
        if (!normalizedSign) {
            return { error: 'invalid_sign' };
        }

        // Check cache
        const cacheKey = this._getCacheKey(normalizedSign);
        const cached = this._cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this._cacheExpiry) {
            logger.debug(`Horoscope cache hit for ${normalizedSign}`);
            return cached.data;
        }

        const { ohmandaResult, vedikaResult, appResult, diagnostics } =
            await this._probeSources(normalizedSign);

        const vedikaOk =
            vedikaResult.status === 'fulfilled'
            && vedikaResult.value?.horoscope
            && this.normalizeSign(vedikaResult.value.apiSign) === normalizedSign;

        const horoscopeText =
            (ohmandaResult.status === 'fulfilled' && ohmandaResult.value)
                ? ohmandaResult.value
                : vedikaOk
                    ? vedikaResult.value.horoscope
                    : (appResult.status === 'fulfilled' && appResult.value)
                        ? appResult.value
                        : '';

        if (!horoscopeText) {
            logger.error(`Horoscope API error for ${normalizedSign}: all sources failed`);
            return { error: 'api_error', diagnostics };
        }

        const extras = this._resolveExtras(
            vedikaOk ? vedikaResult.value : null,
            normalizedSign,
        );

        const data = {
            sign: normalizedSign,
            emoji: ZODIAC_EMOJIS[normalizedSign],
            dates: ZODIAC_DATES[normalizedSign],
            horoscope: horoscopeText,
            mood: extras.mood,
            luckyNumber: extras.luckyNumber,
            luckyColor: extras.luckyColor,
            compatibility: extras.compatibility,
            date: this._formatDate(),
        };

        this._cache.set(cacheKey, { data, timestamp: Date.now() });
        logger.info(`Fetched horoscope for ${normalizedSign}`);
        return data;
    }

    /**
     * Format horoscope message for WhatsApp
     */
    formatMessage(data) {
        if (data.error === 'invalid_sign') {
            return `❌ *Invalid zodiac sign!*\n\n` +
                `📜 *Valid signs:*\n` +
                ZODIAC_SIGNS.map(s => `  ${ZODIAC_EMOJIS[s]} ${s.charAt(0).toUpperCase() + s.slice(1)}`).join('\n') +
                `\n\n💡 *Usage:* \`/horo capricorn\` or \`/horo cap\``;
        }

        if (data.error === 'api_error') {
            return `⚠️ *Horoscope service temporarily unavailable*\n\nPlease try again in a few minutes.`;
        }

        let msg = `╔════════════════════════════╗\n`;
        msg += `║ ${data.emoji} *${data.sign.toUpperCase()}* ${data.emoji}\n`;
        msg += `╚════════════════════════════╝\n\n`;
        msg += `📅 *${data.date}*\n`;
        msg += `🗓️ _${data.dates}_\n\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `🔮 *Today's Horoscope:*\n\n`;
        msg += `${data.horoscope}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `\n🍀 *Today's Luck*\n`;
        msg += `🔢 *Lucky Number:* ${data.luckyNumber ?? '—'}\n`;
        msg += `🎨 *Lucky Color:* ${data.luckyColor ?? '—'}`;

        if (data.mood) {
            msg += `\n😊 *Mood:* ${data.mood}`;
        }
        if (data.compatibility) {
            const compat = String(data.compatibility).trim();
            const compatEmoji = ZODIAC_EMOJIS[compat.toLowerCase()] || '💫';
            msg += `\n💞 *Best Match:* ${compatEmoji} ${compat}`;
        }

        msg += `\n\n✨ _Have a wonderful day!_ ✨`;

        return msg;
    }

    /**
     * Get list of all zodiac signs formatted
     */
    getSignsList() {
        let msg = `🌟 *ZODIAC SIGNS* 🌟\n\n`;
        msg += `Choose your sign:\n\n`;
        
        for (const sign of ZODIAC_SIGNS) {
            const emoji = ZODIAC_EMOJIS[sign];
            const dates = ZODIAC_DATES[sign];
            const name = sign.charAt(0).toUpperCase() + sign.slice(1);
            msg += `${emoji} *${name}* — _${dates}_\n`;
        }
        
        msg += `\n💡 *Usage:* \`/horo <sign>\`\n`;
        msg += `📝 *Example:* \`/horo capricorn\` or \`/horo cap\``;
        
        return msg;
    }
}

export const horoscopeService = new HoroscopeService();
export default HoroscopeService;
