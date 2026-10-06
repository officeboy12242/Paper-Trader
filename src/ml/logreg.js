/**
 * Dependency-free L2-regularised logistic regression.
 *
 * Full-batch gradient descent on standardised features. The datasets here are
 * hundreds to low-thousands of rows over ~16 features, so this converges in
 * well under a second and — unlike pulling in a numeric stack — adds nothing
 * to the deploy surface of a Render starter instance.
 *
 * A model is a plain JSON-safe object:
 *   { mean, std, weights, bias }
 */

/** Numerically safe logistic function. */
export const sigmoid = (z) => (z <= -30 ? 0 : z >= 30 ? 1 : 1 / (1 + Math.exp(-z)));

/** Per-column mean and standard deviation. A constant column gets std 1 so
 *  standardising it produces zeros instead of dividing by zero. */
export function standardizeFit(X) {
    const d = X[0]?.length ?? 0;
    const n = X.length;
    if (!n || !d) throw new Error('standardizeFit: empty dataset');
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(0);
    for (const row of X) {
        if (row.length !== d) throw new Error('standardizeFit: ragged feature matrix');
        for (let j = 0; j < d; j++) mean[j] += row[j];
    }
    for (let j = 0; j < d; j++) mean[j] /= n;
    for (const row of X) for (let j = 0; j < d; j++) { const e = row[j] - mean[j]; std[j] += e * e; }
    for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;
    return { mean, std };
}

export const standardizeApply = (X, mean, std) => X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));

/**
 * @param {number[][]} X feature matrix
 * @param {number[]}   y 0/1 labels
 * @param {{l2?:number, iters?:number, lr?:number, decay?:number}} [opts]
 * @returns {{mean:number[], std:number[], weights:number[], bias:number}}
 */
export function trainLogreg(X, y, { l2 = 0.1, iters = 800, lr = 0.5, decay = 0.002 } = {}) {
    const d = X[0]?.length ?? 0;
    const n = X.length;
    if (!n) throw new Error('trainLogreg: empty dataset');
    if (n !== y.length) throw new Error(`trainLogreg: ${n} rows vs ${y.length} labels`);
    if (!d) throw new Error('trainLogreg: no features');
    for (const row of X) if (row.length !== d) throw new Error('trainLogreg: ragged feature matrix');

    const { mean, std } = standardizeFit(X);
    const Z = standardizeApply(X, mean, std);
    const w = new Array(d).fill(0);
    let b = 0;

    for (let i = 0; i < iters; i++) {
        const rate = lr / (1 + decay * i);
        const gw = new Array(d).fill(0);
        let gb = 0;
        for (let r = 0; r < n; r++) {
            let z = b;
            for (let j = 0; j < d; j++) z += w[j] * Z[r][j];
            const err = sigmoid(z) - y[r];
            for (let j = 0; j < d; j++) gw[j] += err * Z[r][j];
            gb += err;
        }
        for (let j = 0; j < d; j++) w[j] -= rate * ((gw[j] / n) + l2 * w[j]);
        b -= rate * (gb / n);
    }
    return { mean, std, weights: w, bias: b };
}

/** Probability that the row is a winner. */
export function predictLogreg(model, x) {
    const { mean, std, weights, bias } = model;
    let z = bias;
    for (let j = 0; j < weights.length; j++) z += weights[j] * ((x[j] - mean[j]) / std[j]);
    return sigmoid(z);
}

/** Fraction of rows where the 0.5 decision matches the label. */
export function accuracy(model, X, y) {
    if (!X.length) return 0;
    let hits = 0;
    for (let i = 0; i < X.length; i++) if ((predictLogreg(model, X[i]) >= 0.5 ? 1 : 0) === y[i]) hits += 1;
    return hits / X.length;
}

/** Mean negative log-likelihood — punishes confident wrong answers. */
export function logLoss(model, X, y) {
    if (!X.length) return Infinity;
    let total = 0;
    for (let i = 0; i < X.length; i++) {
        const p = Math.min(1 - 1e-12, Math.max(1e-12, predictLogreg(model, X[i])));
        total += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
    }
    return total / X.length;
}

/**
 * AUC — rank correlation between the score and the label. Accuracy can look
 * fine on an imbalanced label set (predict "lose" always); AUC cannot.
 */
export function auc(model, X, y) {
    const pos = [];
    const neg = [];
    for (let i = 0; i < X.length; i++) (y[i] === 1 ? pos : neg).push(predictLogreg(model, X[i]));
    if (!pos.length || !neg.length) return null;
    let wins = 0;
    for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
    return wins / (pos.length * neg.length);
}
