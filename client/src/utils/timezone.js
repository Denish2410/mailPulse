/**
 * Timezone helpers for scheduling: the server stores one UTC instant, so choosing a timezone is
 * purely a client-side conversion of the wall-clock time the user typed.
 */

/** Common IANA zones offered in the schedule picker (the browser's own zone is always added). */
export const COMMON_TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/** @returns {string} The browser's IANA timezone, or 'UTC' when it cannot be determined. */
export const getBrowserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/**
 * @param {string} timeZone
 * @returns {boolean} Whether the runtime recognises the IANA zone name.
 */
export const isValidTimeZone = (timeZone) => {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** Zone list for a <select>: the browser zone first, then the common zones without duplicates. */
export const getTimeZoneOptions = (browserZone = getBrowserTimeZone()) => [
  browserZone,
  ...COMMON_TIME_ZONES.filter((zone) => zone !== browserZone),
];

const partsInZone = (timeZone, utcMs) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
};

/** Offset (zone wall clock minus UTC) in ms at the given instant. */
const zoneOffsetMs = (timeZone, utcMs) => {
  const p = partsInZone(timeZone, utcMs);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
};

/**
 * Interprets a `datetime-local` value (YYYY-MM-DDTHH:mm) as wall-clock time in `timeZone` and
 * returns the matching UTC instant in ms. Returns null for malformed input, an unknown zone, or a
 * wall-clock time that does not exist (skipped by a daylight-saving jump).
 *
 * @param {string} localValue
 * @param {string} timeZone
 * @returns {number|null}
 */
export const zonedLocalToUtcMs = (localValue, timeZone) => {
  if (typeof localValue !== 'string' || !isValidTimeZone(timeZone)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);

  // Two passes settle the offset even when it changes between the guess and the real instant
  let guess = wallAsUtc - zoneOffsetMs(timeZone, wallAsUtc);
  guess = wallAsUtc - zoneOffsetMs(timeZone, guess);

  // Round-trip check rejects times inside a DST gap and out-of-range dates such as 02-31
  const back = partsInZone(timeZone, guess);
  const matches =
    back.year === year && back.month === month && back.day === day &&
    back.hour === hour && back.minute === minute;
  return matches ? guess : null;
};

/**
 * Like `localInputToFutureIso`, but the wall-clock time is read in `timeZone`.
 *
 * @param {string} localValue
 * @param {string} timeZone
 * @param {number} [now=Date.now()]
 * @returns {string|null} ISO string, or null if invalid / not strictly in the future
 */
export const zonedInputToFutureIso = (localValue, timeZone, now = Date.now()) => {
  const ms = zonedLocalToUtcMs(localValue, timeZone);
  if (ms === null || ms <= now) return null;
  return new Date(ms).toISOString();
};

/**
 * Formats an instant for display in a given zone, e.g. "Nov 9, 2026, 9:00 AM GMT+5:30".
 *
 * @param {string|Date} value
 * @param {string} timeZone
 * @returns {string} '' when the value or zone is invalid
 */
export const formatInTimeZone = (value, timeZone) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(timeZone)) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
};
