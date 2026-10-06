/**
 * Render metrics helpers (bandwidth, etc.)
 */

import { config } from '../config/config.js';

export function formatBandwidth(mb) {
    if (!Number.isFinite(mb) || mb < 0) {
        return 'N/A';
    }
    if (mb >= 1024) {
        return `${(mb / 1024).toFixed(2)} GB`;
    }
    return `${mb.toFixed(1)} MB`;
}

/**
 * @param {string} [serviceId] defaults to config.RENDER_SERVICE_ID
 * @param {string} [apiKey] defaults to config.RENDER_API_KEY
 * @returns {Promise<number|null>} total MB this calendar month, or null on failure
 */
export async function fetchMonthlyBandwidthMB(serviceId = config.RENDER_SERVICE_ID, apiKey = config.RENDER_API_KEY) {
    if (!apiKey || !serviceId) {
        return null;
    }

    const startTime = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const endTime = new Date().toISOString();
    const url = new URL('https://api.render.com/v1/metrics/bandwidth');
    url.searchParams.set('resource', serviceId);
    url.searchParams.set('startTime', startTime);
    url.searchParams.set('endTime', endTime);

    const res = await fetch(url, {
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
    });

    if (!res.ok) {
        return null;
    }

    const data = await res.json();
    if (!Array.isArray(data) || !data.length) {
        return 0;
    }

    let totalMB = 0;
    for (const series of data) {
        const seriesUnit = String(series.unit || 'mb').toLowerCase();
        const multiplier = seriesUnit === 'gb' ? 1024 : 1;
        for (const point of series.values || []) {
            totalMB += Number(point?.value || 0) * multiplier;
        }
    }

    return totalMB;
}
