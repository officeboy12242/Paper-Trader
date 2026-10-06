/**
 * Durable scheduler slot flags — survive Render redeploys (Mongo-backed).
 */

const PRUNE_MS = 4 * 24 * 60 * 60 * 1000;

function isSlotsField(memField) {
    return Boolean(memField && (memField.endsWith('Slots') || memField.includes('Slots')));
}

/**
 * @param {import('../models/BotSettings.js').default} botSettings
 * @param {string} kind news|morning|trade|summary|awesome
 */
export function createDurableSlotStore(botSettings, kind) {
    const settingsKey = `scheduler_slots_${kind}`;

    async function loadMap() {
        if (!botSettings?.getJson) return {};
        const map = await botSettings.getJson(settingsKey, {});
        return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    }

    async function saveMap(map) {
        if (!botSettings?.setJson) return;
        const cutoff = Date.now() - PRUNE_MS;
        const pruned = {};
        for (const [k, v] of Object.entries(map)) {
            const ts = typeof v === 'string' ? Date.parse(v) : Number(v) || 0;
            if (!ts || ts >= cutoff) pruned[k] = v;
        }
        await botSettings.setJson(settingsKey, pruned);
    }

    return {
        /**
         * @param {object} botState
         * @param {string} slotKey
         * @param {string} [memField] botState field for in-process cache
         */
        async isDone(botState, slotKey, memField = null) {
            if (!slotKey) return false;
            if (memField) {
                const cur = botState[memField];
                if (typeof cur === 'string' && cur === slotKey) return true;
                if (cur && typeof cur === 'object' && cur[slotKey]) return true;
            }
            const map = await loadMap();
            if (!map[slotKey]) return false;
            if (memField) {
                if (isSlotsField(memField)) {
                    if (!botState[memField] || typeof botState[memField] !== 'object') {
                        botState[memField] = {};
                    }
                    botState[memField][slotKey] = true;
                } else {
                    botState[memField] = slotKey;
                }
            }
            return true;
        },

        async markDone(botState, slotKey, memField = null) {
            if (!slotKey) return;
            if (memField) {
                if (isSlotsField(memField)) {
                    if (!botState[memField] || typeof botState[memField] !== 'object') {
                        botState[memField] = {};
                    }
                    botState[memField][slotKey] = true;
                } else {
                    botState[memField] = slotKey;
                }
            }
            const map = await loadMap();
            map[slotKey] = new Date().toISOString();
            await saveMap(map);
        },
    };
}
