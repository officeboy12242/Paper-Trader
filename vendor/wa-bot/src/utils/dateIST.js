/**
 * Calendar date helpers in Asia/Kolkata (IST).
 */

const IST = 'Asia/Kolkata';

const istDatePartsFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

const istLabelFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
});

/** YYYY-MM-DD in IST (works on UTC servers like Render). */
export function getTodayDateStrIST(fromMs = Date.now()) {
    return istDatePartsFormatter.format(new Date(fromMs));
}

/** Calendar day before today in IST. */
export function getYesterdayDateStrIST(fromMs = Date.now()) {
    return getTodayDateStrIST(fromMs - 24 * 60 * 60 * 1000);
}

/**
 * Which IST calendar day to summarize when the job runs.
 * Midnight (00:00) → day that just ended; evening slot → same IST date.
 */
export function getRecapDateStrIST(fromMs = Date.now(), recapHour = 0, recapMinute = 0) {
    if (recapHour === 0 && recapMinute === 0) {
        return getYesterdayDateStrIST(fromMs);
    }
    return getTodayDateStrIST(fromMs);
}

/** e.g. "Friday, 3 July 2026" — always IST regardless of server timezone. */
export function formatDateLabelIST(dateStr) {
    const instant = new Date(`${dateStr}T12:00:00+05:30`);
    return istLabelFormatter.format(instant);
}

/** Live "now" label in IST for alert headers. */
export function formatNowLabelIST(fromMs = Date.now()) {
    return istLabelFormatter.format(new Date(fromMs));
}
