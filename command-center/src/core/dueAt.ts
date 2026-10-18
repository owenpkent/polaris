// Due dates and due times. A task's dueAt is 'YYYY-MM-DD' (a day) or, with a time, an ISO
// datetime. The dashboard and the CLI write a time as floating local time, 'YYYY-MM-DDTHH:MM' with
// no zone: nine in the morning wherever the owner is. Every day-level question (is it overdue, is
// it due today, which digest section) is answered on the first ten characters, so a task due at a
// time behaves as its day; the time only orders tasks within that day, untimed ones first, which
// plain string order already does ('2026-10-18' < '2026-10-18T09:00' < '2026-10-19').
//
// A value that names a zone or an offset ('2026-10-20T00:00:00.000Z', the toISOString() an agent
// sends, or '+02:00') is a moment, not a time on the owner's clock. The store turns it into
// floating local time in the configured timezone on the way in (toLocalDue), so every reader sees
// the same day and the same time, and a reminder fires at the time the list shows. Exactly
// midnight UTC is the exception: it is what JavaScript's toISOString() makes of a plain date, so it
// is stored as that date ('2026-10-20T00:00:00.000Z' is '2026-10-20'), never as the evening before.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
// What a person types: a day, then a space or a T, then HH:MM.
const TYPED = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/;

/** The day a due date falls on: its 'YYYY-MM-DD'. */
export function dueDay(dueAt: string): string {
  return dueAt.slice(0, 10);
}

/** True when the value is a plain 'YYYY-MM-DD' day with no time. */
export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

/**
 * A due date for people to read: the day alone, or the day and the time with a space between
 * ('2026-10-18 09:00'). Zero seconds are left out; other seconds and a zone the value carries are
 * kept, so nothing is hidden. Anything else comes back unchanged.
 */
export function formatDue(dueAt: string): string {
  const m = DATETIME.exec(dueAt);
  if (!m) return dueAt;
  const [, day, hm, seconds, zone] = m;
  const keepSeconds = seconds && !/^:00(?:\.0+)?$/.test(seconds) ? seconds : '';
  return `${day} ${hm}${keepSeconds}${zone ? ` ${zone}` : ''}`;
}

/**
 * A due date as typed on the command line: 'YYYY-MM-DD', or 'YYYY-MM-DD HH:MM' (a T works in
 * place of the space), stored as 'YYYY-MM-DDTHH:MM'. Anything else is passed through for the store
 * to accept or refuse, so a full ISO datetime still works.
 */
export function parseDueInput(raw: string): string {
  const v = raw.trim();
  const m = TYPED.exec(v);
  if (!m) return v;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) throw new Error(`"${raw}" is not a time of day. Use YYYY-MM-DD HH:MM, 24-hour.`);
  return `${m[1]}T${String(hour).padStart(2, '0')}:${m[3]}`;
}

const MIDNIGHT_UTC = /^T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)$/;

/**
 * A due value as the store keeps it, and how a due filter is read: a day or a floating local time
 * passes through unchanged; exactly midnight UTC becomes its date; any other value with a zone or
 * an offset becomes floating local time in `timezone` ('YYYY-MM-DDTHH:MM', with ':SS' only when
 * the seconds are not zero). Anything else passes through for validation to judge.
 */
export function toLocalDue(value: string, timezone: string): string {
  const m = DATETIME.exec(value);
  if (!m || !m[4]) return value;
  if (MIDNIGHT_UTC.test(value.slice(10))) return m[1];
  const zone = m[4] === 'Z' ? 'Z' : m[4].length === 5 ? `${m[4].slice(0, 3)}:${m[4].slice(3)}` : m[4];
  const instant = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ''}${zone}`);
  if (Number.isNaN(instant)) return value;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const seconds = get('second');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}${seconds === '00' ? '' : `:${seconds}`}`;
}
