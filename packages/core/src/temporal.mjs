const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function isGregorianDate(value) {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

export function isRfc3339Instant(value) {
  const match = typeof value === "string" ? INSTANT.exec(value) : null;
  if (!match || !isGregorianDate(`${match[1]}-${match[2]}-${match[3]}`)) return false;
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0), offsetMinute = Number(match[11] ?? 0);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;
  return Number.isFinite(Date.parse(value));
}

export function utcDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  if (!isRfc3339Instant(value)) return null;
  return new Date(value).toISOString().slice(0, 10);
}

export function isStaleOn(staleAfter, today) {
  return !isGregorianDate(staleAfter) || !isGregorianDate(today) || today >= staleAfter;
}
