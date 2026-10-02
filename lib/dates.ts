// Warehouse operations run on Asia/Jakarta. The database session is UTC, so
// every filter must be an absolute instant, not a bare YYYY-MM-DD string.

export const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE || 'Asia/Jakarta';

function timeZoneOffsetMs(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  let hour = pick('hour');
  // Some engines format midnight as hour 24.
  if (hour === 24) hour = 0;

  const wallAsUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    hour,
    pick('minute'),
    pick('second'),
  );
  return wallAsUtc - instant.getTime();
}

/** Interpret a civil date and time in `timeZone` as a UTC instant. */
export function zonedWallTimeToUtc(day: string, time: string, timeZone = APP_TIMEZONE) {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, date, hour, minute, second || 0);
  // Second pass covers offset changes around a DST boundary.
  let utc = wallAsUtc - timeZoneOffsetMs(new Date(wallAsUtc), timeZone);
  utc = wallAsUtc - timeZoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

export function todayInAppTimezone(now = new Date(), timeZone = APP_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function shiftDay(day: string, delta: number) {
  const [year, month, date] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + delta));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function hourInTimeZone(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
  }).formatToParts(now);
  let hour = Number(parts.find((part) => part.type === 'hour')?.value);
  if (hour === 24) hour = 0;
  return hour;
}

/**
 * Day the daily email should cover.
 * Vercel cron `0 19 * * *` is 19:00 UTC, which is 02:00 in Jakarta. A run in
 * the first hours after local midnight reports the warehouse day that just ended.
 */
export function reportDay(now = new Date(), timeZone = APP_TIMEZONE) {
  const day = todayInAppTimezone(now, timeZone);
  return hourInTimeZone(now, timeZone) < 4 ? shiftDay(day, -1) : day;
}

/** Inclusive UTC instants for a civil date range in the app timezone. */
export function rangeIso(startDay: string, endDay: string, timeZone = APP_TIMEZONE) {
  const [from, to] = startDay <= endDay ? [startDay, endDay] : [endDay, startDay];
  const start = zonedWallTimeToUtc(from, '00:00:00', timeZone);
  const end = new Date(zonedWallTimeToUtc(to, '23:59:59', timeZone).getTime() + 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function formatInAppTimezone(iso: string, timeZone = APP_TIMEZONE) {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}
