/**
 * Scoring side of the model: decision time only.
 *
 * Returns null — never throws — for anything the gate should silently pass
 * through, so a malformed model or a missing feature row degrades into "no
 * opinion" rather than a blocked scan.
 */

import { predictLogreg } from './logreg.js';
import { featuresFor } from './features.js';

/**
 * @param {{weights?:number[], mean?:number[], std?:number[], bias?:number}|null} model
 * @param {object} input the same shape `featuresFor` takes at decision time
 * @returns {number|null} probability the trade wins, or null for no opinion
 */
export function scoreModel(model, input) {
    if (!model || !Array.isArray(model.weights) || !model.weights.length) return null;
    if (!Array.isArray(model.mean) || !Array.isArray(model.std)) return null;
    try {
        const p = predictLogreg(model, featuresFor(input));
        return Number.isFinite(p) ? p : null;
    } catch {
        return null;
    }
}
