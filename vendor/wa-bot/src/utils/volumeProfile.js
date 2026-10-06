/**
 * Volume Profile + VWAP + Absorption Engine
 *
 * Implements Fabio Valentini's Auction Market Theory concepts:
 * - Volume Profile: POC (Point of Control), VAH (Value Area High),
 *   VAL (Value Area Low), LVN (Low Volume Nodes)
 * - Session VWAP with standard deviation bands
 * - Absorption detection via OI delta analysis
 *
 * All calculations work on intraday OHLC bars (5-min or 15-min).
 */

/**
 * Build a Volume Profile from intraday OHLCV bars.
 * Distributes each bar's volume across its price range (high-low),
 * then identifies POC, VAH, VAL, and LVNs.
 *
 * @param {Array<{high:number, low:number, close:number, volume:number}>} bars
 * @param {number} [tickSize=5] - Price bin size (default 5 pts for NIFTY)
 * @returns {{ poc, vah, val, lvns, bins, totalVolume }}
 */
export function buildVolumeProfile(bars, tickSize = 5) {
    if (!bars || bars.length === 0) return null;

    // 1. Build volume distribution across price bins
    const bins = new Map();
    let totalVolume = 0;

    for (const bar of bars) {
        if (!bar || !Number.isFinite(bar.high) || !Number.isFinite(bar.low)) continue;
        const vol = bar.volume > 0 ? bar.volume : 1;
        totalVolume += vol;

        const low = Math.floor(bar.low / tickSize) * tickSize;
        const high = Math.ceil(bar.high / tickSize) * tickSize;
        const numBins = Math.max(1, Math.round((high - low) / tickSize));

        // Distribute volume evenly across touched bins
        const volPerBin = vol / numBins;
        for (let p = low; p < high; p += tickSize) {
            bins.set(p, (bins.get(p) || 0) + volPerBin);
        }
    }

    if (bins.size === 0) return null;

    // 2. Find POC (Point of Control) — price with highest volume
    let poc = null;
    let maxVol = 0;
    for (const [price, vol] of bins) {
        if (vol > maxVol) {
            maxVol = vol;
            poc = price;
        }
    }

    // 3. Calculate Value Area (70% of total volume centered on POC)
    const valueAreaPct = 0.70;
    const targetVol = totalVolume * valueAreaPct;
    let accumulatedVol = bins.get(poc) || 0;
    let vah = poc;
    let val = poc;

    const sortedPrices = [...bins.keys()].sort((a, b) => a - b);
    const pocIdx = sortedPrices.indexOf(poc);

    let upIdx = pocIdx + 1;
    let downIdx = pocIdx - 1;

    while (accumulatedVol < targetVol && (upIdx < sortedPrices.length || downIdx >= 0)) {
        const upVol = upIdx < sortedPrices.length ? bins.get(sortedPrices[upIdx]) || 0 : 0;
        const downVol = downIdx >= 0 ? bins.get(sortedPrices[downIdx]) || 0 : 0;

        if (upVol >= downVol && upIdx < sortedPrices.length) {
            accumulatedVol += upVol;
            vah = sortedPrices[upIdx];
            upIdx++;
        } else if (downIdx >= 0) {
            accumulatedVol += downVol;
            val = sortedPrices[downIdx];
            downIdx--;
        } else {
            break;
        }
    }

    // 4. Find Low Volume Nodes (LVN) — bins with volume < 25% of POC volume
    const lvnThreshold = maxVol * 0.25;
    const lvns = [];
    for (const price of sortedPrices) {
        if ((bins.get(price) || 0) < lvnThreshold) {
            lvns.push(price);
        }
    }

    // Consolidate consecutive LVN prices into ranges
    const lvnRanges = [];
    if (lvns.length > 0) {
        let start = lvns[0];
        let end = lvns[0];
        for (let i = 1; i < lvns.length; i++) {
            if (lvns[i] === end + tickSize) {
                end = lvns[i];
            } else {
                lvnRanges.push({ low: start, high: end + tickSize });
                start = lvns[i];
                end = lvns[i];
            }
        }
        lvnRanges.push({ low: start, high: end + tickSize });
    }

    return {
        poc: poc,
        vah: vah,
        val: val,
        lvns: lvnRanges,
        bins: Object.fromEntries(bins),
        totalVolume,
        pocVolume: maxVol,
    };
}

/**
 * Calculate session VWAP with upper and lower standard deviation bands.
 * VWAP = Cumulative(Price x Volume) / Cumulative(Volume)
 * Band = VWAP +/- StdDev(Distance from VWAP) * multiplier
 *
 * @param {Array<{high:number, low:number, close:number, volume:number}>} bars
 * @param {number} [bandMultiplier=2]
 * @returns {{ vwap, upperBand, lowerBand, upper1, lower1, cumulativePV, cumulativeVol }}
 */
export function calcSessionVWAP(bars, bandMultiplier = 2) {
    if (!bars || bars.length === 0) return null;

    let cumPV = 0;
    let cumVol = 0;
    const deviations = [];

    for (const bar of bars) {
        if (!bar || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)) continue;
        const typical = (bar.high + bar.low + bar.close) / 3;
        const vol = bar.volume > 0 ? bar.volume : 1;
        cumPV += typical * vol;
        cumVol += vol;

        const currentVwap = cumPV / cumVol;
        deviations.push(Math.abs(typical - currentVwap));
    }

    if (cumVol === 0 || deviations.length === 0) return null;

    const vwap = cumPV / cumVol;

    // Standard deviation of price-VWAP distances
    const meanDev = deviations.reduce((a, b) => a + b, 0) / deviations.length;
    const variance = deviations.reduce((a, d) => a + (d - meanDev) ** 2, 0) / deviations.length;
    const stdDev = Math.sqrt(variance);

    return {
        vwap: Math.round(vwap * 100) / 100,
        upperBand: Math.round((vwap + bandMultiplier * stdDev) * 100) / 100,
        lowerBand: Math.round((vwap - bandMultiplier * stdDev) * 100) / 100,
        upper1: Math.round((vwap + stdDev) * 100) / 100,
        lower1: Math.round((vwap - stdDev) * 100) / 100,
        stdDev: Math.round(stdDev * 100) / 100,
        cumulativePV: cumPV,
        cumulativeVol: cumVol,
    };
}

/**
 * Absorption on real intraday bars: effort without result.
 *
 * A bar that trades far above average volume but covers far less than its
 * average range means someone sized absorbed everything thrown at that price.
 * Where the bar CLOSES inside its own range says which side did the absorbing:
 * closing near the high means buyers soaked up the selling (bullish), near the
 * low means sellers capped the buying (bearish).
 *
 * This replaces the OI-delta version below for live use. That one needs
 * consecutive chain snapshots of a single strike over time, and nothing in this
 * bot stores chain history — it was being handed one strike row from a single
 * instant, so it returned zero every time and its card section never rendered.
 *
 * @param {Array<{high:number, low:number, close:number, volume:number}>} bars
 * @param {number} [lookback=12] bars to consider (12 x 5m = last hour)
 * @returns {{ level, score, side, isAbsorbing, volRatio, rangeRatio }|null}
 */
export function detectBarAbsorption(bars, lookback = 12) {
    if (!Array.isArray(bars) || bars.length < lookback + 5) return null;

    const baseline = bars.slice(0, -lookback);
    const recent = bars.slice(-lookback);

    const avgVol = baseline.reduce((s, b) => s + (b.volume || 0), 0) / baseline.length;
    const avgRange = baseline.reduce((s, b) => s + (b.high - b.low), 0) / baseline.length;
    // Without volume every bar looks identical on the effort axis, so there is
    // no absorption to find. Say so rather than reporting a fabricated score.
    if (!(avgVol > 0) || !(avgRange > 0)) return null;

    let best = null;
    for (const b of recent) {
        const range = b.high - b.low;
        const volRatio = (b.volume || 0) / avgVol;
        const rangeRatio = range / avgRange;
        if (!(volRatio > 1.5) || !(rangeRatio < 0.8) || !(range > 0)) continue;

        // Effort (volume) divided by result (range) — higher means more absorbed.
        const score = Math.min(100, Math.round((volRatio / Math.max(0.15, rangeRatio)) * 20));
        const closePos = (b.close - b.low) / range;   // 0 = at low, 1 = at high
        if (!best || score > best.score) {
            best = {
                level: Math.round(((b.high + b.low + b.close) / 3) * 20) / 20,
                score,
                side: closePos >= 0.6 ? 'buyers' : closePos <= 0.4 ? 'sellers' : 'balanced',
                isAbsorbing: score >= 40,
                volRatio: Math.round(volRatio * 100) / 100,
                rangeRatio: Math.round(rangeRatio * 100) / 100,
            };
        }
    }
    return best;
}

/**
 * Detect absorption at a price level from OI deltas.
 *
 * NOTE: requires >= 3 CONSECUTIVE snapshots of the same strike over time. This
 * bot does not persist option-chain history, so there is currently no caller —
 * prefer detectBarAbsorption() above. Kept for when chain snapshots are stored.
 *
 * Absorption = large OI buildup + small price movement
 * = "smart money is absorbing all selling/buying at this level"
 *
 * @param {Array<{ce_oi:number, pe_oi:number, close:number}>} snapshots
 *   - Consecutive option chain snapshots with OI and spot price
 * @param {number} strikeToCheck - The strike level to check for absorption
 * @returns {{ ceAbsorption, peAbsorption, absorptionScore, isAbsorbing }}
 */
export function detectAbsorption(snapshots, strikeToCheck) {
    if (!snapshots || snapshots.length < 3) {
        return { ceAbsorption: 0, peAbsorption: 0, absorptionScore: 0, isAbsorbing: false };
    }

    const deltas = [];
    for (let i = 1; i < snapshots.length; i++) {
        const prev = snapshots[i - 1];
        const curr = snapshots[i];
        const spotMove = Math.abs(curr.close - prev.close);

        // CE OI change (call writers adding = bearish absorption at this level)
        const ceOICDelta = (curr.ce_oi || 0) - (prev.ce_oi || 0);
        // PE OI change (put writers adding = bullish absorption at this level)
        const peOICDelta = (curr.pe_oi || 0) - (prev.pe_oi || 0);

        // Absorption score: large OI change + small spot move = high absorption
        // Normalize: 100K OI change = 100, 5pt spot move = 100
        const spotMoveNorm = Math.max(0.1, 5 / Math.max(1, spotMove)); // inverse: small move = high score

        deltas.push({
            ceDelta: ceOICDelta,
            peDelta: peOICDelta,
            spotMove: spotMove,
            ceAbsorption: Math.min(100, Math.abs(ceOICDelta) / 1000 * spotMoveNorm),
            peAbsorption: Math.min(100, Math.abs(peOICDelta) / 1000 * spotMoveNorm),
        });
    }

    // Average absorption across recent snapshots
    const avgCeAbs = deltas.reduce((s, d) => s + d.ceAbsorption, 0) / deltas.length;
    const avgPeAbs = deltas.reduce((s, d) => s + d.peAbsorption, 0) / deltas.length;
    const absorptionScore = Math.round(Math.max(avgCeAbs, avgPeAbs));

    return {
        ceAbsorption: Math.round(avgCeAbs),
        peAbsorption: Math.round(avgPeAbs),
        absorptionScore,
        isAbsorbing: absorptionScore > 40, // threshold: OI building up while price stays still
        dominantSide: avgCeAbs > avgPeAbs ? 'CE' : 'PE',
    };
}

/**
 * Determine market regime based on Volume Profile structure.
 *
 * Balanced market: spot is between VAH and VAL (range-bound)
 * Imbalanced/Breakout: spot is outside VAH or VAL (trending)
 *
 * @param {number} spot
 * @param {{ poc, vah, val }} vp
 * @returns {{ regime, position, description }}
 */
export function auctionRegime(spot, vp) {
    if (!vp || !Number.isFinite(spot)) {
        return { regime: 'unknown', position: 0.5, description: 'Insufficient data' };
    }

    const range = vp.vah - vp.val;
    if (range <= 0) return { regime: 'unknown', position: 0.5, description: 'No volume range' };

    const position = (spot - vp.val) / range; // 0 = at VAL, 1 = at VAH
    const distFromPoc = Math.abs(spot - vp.poc);
    const distFromRange = Math.min(spot - vp.val, vp.vah - spot);

    // 80% rule: if within 20% of VAH/VAL with volume support, expect reversal
    const nearVal = position < 0.20;
    const nearVah = position > 0.80;
    const withinRange = position >= 0.10 && position <= 0.90;
    const outsideRange = position < 0 || position > 1;

    let regime, description;

    if (outsideRange) {
        regime = 'breakout';
        description = position < 0
            ? 'Below VAL — bearish breakout or overshoot'
            : 'Above VAH — bullish breakout or overshoot';
    } else if (nearVal) {
        regime = 'buy_zone';
        description = 'Near VAL (80% rule) — potential bullish reversal';
    } else if (nearVah) {
        regime = 'sell_zone';
        description = 'Near VAH (80% rule) — potential bearish reversal';
    } else if (withinRange) {
        regime = 'balanced';
        description = 'Within value area — range-bound market';
    } else {
        regime = 'transitioning';
        description = 'Near boundary of value area';
    }

    return { regime, position: Math.round(position * 100), description, distFromPoc };
}

/**
 * Get VWAP-based dynamic support and resistance levels.
 * VWAP acts as dynamic fair value — price tends to mean-revert to it.
 *
 * @param {{ vwap, upperBand, lowerBand, upper1, lower1 }} vwapData
 * @param {number} spot
 * @returns {{ support, resistance, bias, vwapDist }}
 */
export function vwapLevels(vwapData, spot) {
    if (!vwapData || !Number.isFinite(spot)) {
        return { support: null, resistance: null, bias: 'neutral', vwapDist: 0 };
    }

    const { vwap, upperBand, lowerBand, upper1, lower1 } = vwapData;
    const vwapDist = spot - vwap;

    // Compare spot against the band LEVELS. Comparing the distance (spot - vwap,
    // tens of points) against upper1 (an absolute price, ~24,000) made the
    // overbought/oversold branches unreachable — NIFTY would have had to trade
    // ~24,000 points above its own VWAP to register as overbought.
    let bias;
    if (spot > upper1) bias = 'overbought';
    else if (spot > vwap) bias = 'bullish';
    else if (spot < lower1) bias = 'oversold';
    else bias = 'bearish';

    // Dynamic support = VWAP or lower band depending on position
    const support = spot > vwap ? vwap : lowerBand;
    const resistance = spot < vwap ? vwap : upperBand;

    return {
        support: Math.round(support * 100) / 100,
        resistance: Math.round(resistance * 100) / 100,
        bias,
        vwapDist: Math.round(vwapDist * 100) / 100,
        vwap: vwapData.vwap,
    };
}

/**
 * Combine Volume Profile + VWAP + OI into a confluence score (0-100).
 * Higher score = stronger setup.
 *
 * @param {{ poc, vah, val }} vp - Volume profile
 * @param {{ vwap, bias, vwapDist }} vwapInfo - VWAP data
 * @param {{ pcr, oiWall, regime }} oiData - OI structure
 * @returns {{ score, factors }}
 */
export function confluenceScore(vp, vwapInfo, oiData) {
    const factors = [];
    let total = 0;
    let weightSum = 0;

    // 1. Volume Profile alignment (weight: 0.35)
    if (vp) {
        const { poc, vah, val } = vp;
        const range = vah - val;
        const spotDistFromPoc = oiData?.spotDistance || 0;
        const vpScore = Math.max(0, 100 - (spotDistFromPoc / (range || 100)) * 100);
        factors.push({ name: 'VP Alignment', score: Math.round(vpScore), weight: 0.35 });
        total += vpScore * 0.35;
        weightSum += 0.35;
    }

    // 2. VWAP confirmation (weight: 0.25)
    if (vwapInfo) {
        let vwapScore = 50;
        if (vwapInfo.bias === 'bullish' || vwapInfo.bias === 'oversold') vwapScore = 75;
        else if (vwapInfo.bias === 'bearish' || vwapInfo.bias === 'overbought') vwapScore = 25;
        // Distance from VWAP boosts score if near support/resistance
        const distPct = Math.abs(vwapInfo.vwapDist) / (vwapInfo.vwap * 0.005) * 100;
        vwapScore = Math.min(95, vwapScore + distPct * 0.2);
        factors.push({ name: 'VWAP Signal', score: Math.round(vwapScore), weight: 0.25 });
        total += vwapScore * 0.25;
        weightSum += 0.25;
    }

    // 3. OI wall strength (weight: 0.25)
    // Takes RAW open interest. This previously received OI pre-divided by 10,000
    // and then divided again by 100, so "1L OI = full score" actually needed 10L
    // and every real wall scored around 16/100.
    if (oiData?.oiWall) {
        const oiScore = Math.min(100, (oiData.oiWall / 100_000) * 100); // 1L OI = full score
        factors.push({ name: 'OI Wall', score: Math.round(oiScore), weight: 0.25 });
        total += oiScore * 0.25;
        weightSum += 0.25;
    }

    // 4. Regime alignment (weight: 0.15)
    if (oiData?.regime) {
        let regimeScore = 50;
        if (oiData.regime === 'trending' || oiData.regime === 'breakout') regimeScore = 70;
        else if (oiData.regime === 'low_vol') regimeScore = 40;
        else regimeScore = 60;
        factors.push({ name: 'Regime', score: Math.round(regimeScore), weight: 0.15 });
        total += regimeScore * 0.15;
        weightSum += 0.15;
    }

    const finalScore = weightSum > 0 ? Math.round(total / weightSum) : 50;

    return {
        score: Math.max(20, Math.min(95, finalScore)),
        factors,
    };
}

/**
 * Simulate volume profile from daily candles (for backtesting).
 * Uses OHLC to approximate intraday volume distribution.
 *
 * @param {Array<{open:number, high:number, low:number, close:number, volume:number}>} dailyBars
 * @param {number} [tickSize=10]
 * @returns {{ poc, vah, val, lvns }}
 */
export function simulateVolumeProfileFromDaily(dailyBars, tickSize = 10) {
    if (!dailyBars || dailyBars.length < 5) return null;

    // Use recent bars (e.g., last 30 days) for session profile
    const recent = dailyBars.slice(-30);

    // Create bins from daily OHLC
    const bins = new Map();
    let totalVolume = 0;

    for (const bar of recent) {
        if (!bar || !Number.isFinite(bar.high) || !Number.isFinite(bar.low)) continue;
        const vol = bar.volume > 0 ? bar.volume : 1;
        totalVolume += vol;

        const low = Math.floor(bar.low / tickSize) * tickSize;
        const high = Math.ceil(bar.high / tickSize) * tickSize;

        // Emphasize typical price (H+L+C)/3
        const typical = Math.round(((bar.high + bar.low + bar.close) / 3) / tickSize) * tickSize;
        const typicalVol = vol * 0.6; // 60% at typical price
        bins.set(typical, (bins.get(typical) || 0) + typicalVol);

        // Remaining volume spread between high and low
        const spreadVol = vol * 0.4 / Math.max(1, (high - low) / tickSize);
        for (let p = low; p <= high; p += tickSize) {
            if (p !== typical) {
                bins.set(p, (bins.get(p) || 0) + spreadVol);
            }
        }
    }

    if (bins.size === 0) return null;

    // POC
    let poc = null, maxVol = 0;
    for (const [price, vol] of bins) {
        if (vol > maxVol) { maxVol = vol; poc = price; }
    }

    // Value area (70%)
    const targetVol = totalVolume * 0.7;
    let accumulated = bins.get(poc) || 0;
    let vah = poc, val = poc;
    const sorted = [...bins.keys()].sort((a, b) => a - b);
    const pocIdx = sorted.indexOf(poc);
    let up = pocIdx + 1, down = pocIdx - 1;

    while (accumulated < targetVol && (up < sorted.length || down >= 0)) {
        const uv = up < sorted.length ? bins.get(sorted[up]) || 0 : 0;
        const dv = down >= 0 ? bins.get(sorted[down]) || 0 : 0;
        if (uv >= dv && up < sorted.length) {
            accumulated += uv; vah = sorted[up]; up++;
        } else if (down >= 0) {
            accumulated += dv; val = sorted[down]; down--;
        } else break;
    }

    return { poc, vah, val, totalVolume, pocVolume: maxVol };
}
