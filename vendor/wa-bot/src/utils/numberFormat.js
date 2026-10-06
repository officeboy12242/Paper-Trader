export function parseLooseCount(value) {
    if (value === null || value === undefined || value === '') {
        return 0;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }

    const raw = String(value).trim().toLowerCase().replace(/,/g, '');
    const match = raw.match(/^([\d.]+)\s*([kmb])?$/);
    if (!match) {
        const parsed = Number.parseFloat(raw);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount)) {
        return 0;
    }

    const multiplier = {
        k: 1_000,
        m: 1_000_000,
        b: 1_000_000_000,
    }[match[2]] || 1;

    return Math.round(amount * multiplier);
}

export function formatCompactCount(value) {
    const count = parseLooseCount(value);
    if (!count) {
        return '0';
    }
    return new Intl.NumberFormat('en', {
        notation: 'compact',
        maximumFractionDigits: 1,
    }).format(count);
}
