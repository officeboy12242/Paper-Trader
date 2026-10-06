/**
 * Exponential moving average (seeded with SMA of first `period` closes).
 * @param {number[]} closes
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function computeEma(closes, period = 8) {
    const n = Math.max(1, Number(period) || 8);
    const k = 2 / (n + 1);
    const out = new Array(closes.length).fill(null);
    let seedSum = 0;
    let seeded = 0;
    let ema = null;

    for (let i = 0; i < closes.length; i++) {
        const c = Number(closes[i]);
        if (!Number.isFinite(c)) continue;

        if (ema == null) {
            seedSum += c;
            seeded += 1;
            if (seeded < n) continue;
            ema = seedSum / n;
            out[i] = ema;
            continue;
        }

        ema = c * k + ema * (1 - k);
        out[i] = ema;
    }
    return out;
}

/** Last finite EMA slope: current − previous finite value. */
export function emaSlope(emas, idx) {
    const cur = emas[idx];
    if (!Number.isFinite(cur)) return null;
    for (let j = idx - 1; j >= 0; j--) {
        if (Number.isFinite(emas[j])) return cur - emas[j];
    }
    return null;
}
